# async compaction design

This Pi extension precomputes Pi-compatible compaction summaries in the background when compaction mode is explicitly set to `async`, usually waits for a safe idle boundary before triggering Pi's compaction flow, and supplies the ready summary through Pi's normal compaction hook. Startup defaults to `normal`; only exact `PI_COMPACTION_MODE=async` opts in. `normal` mode starts and hands off no extension work, leaving native Pi compaction untouched. If a ready result exists during an abortable active turn over the async threshold, it follows Pi's normal compaction behavior by aborting before compacting.

Code entrypoint: [`src/index.ts`](./src/index.ts)
Experimental adapter entrypoint for other packages: [`src/core.ts`](./src/core.ts)

## goal

Pi compaction normally prepares a prefix of the active branch, asks the active model to summarize it, persists a `CompactionEntry`, and resumes from:

```text
compaction summary + raw tail from firstKeptEntryId
```

The model call is synchronous and blocks the agent. This extension moves summary generation earlier by running the selected backend (`web` by default, or Pi `provider`) in the background after a turn. When the background result becomes ready, the extension applies it through Pi's ordinary compaction pipeline when `ctx.isIdle()` and `!ctx.hasPendingMessages()`. If Pi is actively responding with an abort signal, has no queued messages, and current usage is still above `PI_ASYNC_PREFIX_COMPACTION_START_RATIO`, the extension aborts first and triggers Pi compaction. After Pi persists that extension-provided compaction, the extension sends `continue` once to resume work.

Quality goal: async compaction should preserve Pi's preparation, validation, handoff, and persistence lifecycle. Its default backend builds Pi-format structured checkpoint prompts, serializes messages through Pi's exported `convertToLlm()` and `serializeConversation()`, then submits them to an authenticated ChatGPT web session. File-operation tags and split-turn composition remain local Pi-compatible logic; Pi model authentication is never used by the default backend.

## hooks used

### `turn_end`

After each turn, the extension checks `ctx.getContextUsage()` and Pi compaction settings from a trust-aware `SettingsManager` configured with `ctx.isProjectTrusted()`.

A background job starts when:

```text
contextTokens > contextWindow * PI_ASYNC_PREFIX_COMPACTION_START_RATIO
contextTokens <= contextWindow - piSettings.compaction.reserveTokens
```

`PI_ASYNC_PREFIX_COMPACTION_START_RATIO` is only the early-start threshold. Reserve and keep-recent behavior come from Pi compaction settings.

### `agent_settled`

When a background job is already ready, this hook attempts to apply it after the full user prompt completes or is cancelled with Escape. `turn_end` is not sufficient because a single prompt can contain multiple LLM/tool turns.

Pi emits `agent_settled` after the agent and queued work have settled, so the extension uses that lifecycle boundary directly instead of polling `ctx.isIdle()`. If queued steering/follow-up messages remain, the ready summary stays in memory and the adapter-scoped status line remains `<adapter label>: ready`.

### `session_before_compact`

When Pi runs compaction — either because this extension safely called `ctx.compact()`, because the user ran manual `/compact`, or because Pi auto-compacted — the extension validates the ready job and returns:

```ts
{ compaction: readyCompactionResult }
```

Pi persists it as a normal extension-provided compaction entry. If validation fails, the extension returns nothing and Pi runs default synchronous compaction.

### `session_compact`

Notification only, after Pi persists a compaction supplied by this extension. The notification checks the `details.asyncPrefixCompaction` marker so other extensions' compactions are not misattributed.

### invalidation hooks

The extension stales pending/ready jobs on model changes, thinking-level changes, tree navigation, and session shutdown.

## state model

One in-memory job is tracked:

```text
idle -> pending -> ready -> idle
              \-> stale | failed
```

`/async-compact-now` starts a background job immediately, bypassing the early-start threshold while still respecting the enabled/model/settings/preparation guards. If a reusable ready job already exists, the command requests apply through the same apply gate; active abort-and-compact still requires current usage above the async threshold.

Pending background work is shown through Pi's CLI status line.

Pi reports context usage as unknown after compaction until a later assistant response provides fresh usage.

No pending/ready metadata is persisted. Only an applied compaction is persisted by Pi as a normal `CompactionEntry`. `/compaction-mode normal|async` and `/async-compaction-backend provider|web` stale pending/ready work before changing future behavior; mode and backend remain independent. Backend selection has one stable generic adapter identity and a backend-specific snapshotted prompt version for marker correlation; provider retains Pi's established `pi-compact-background-v1` marker version. `/async-compact-compare` is outside this state machine: it prepares once, runs provider and web concurrently, is single-flight, observes the available context abort signal and the configured async timeout, and writes operator-only artifacts without creating a ready result or invoking Pi apply/persistence. A timeout preserves a completed side while aborting unfinished work.

## experimental adapter api

Other compaction packages can opt into the same lifecycle by importing `registerAsyncCompaction` from `pi-async-compaction/core` and supplying an `AsyncCompactionAdapter<TPrepared, TResult>`. See the package-author guide in [`docs/async-compaction-adapters.md`](./docs/async-compaction-adapters.md).

The lifecycle boundary is:

1. `prepare()` snapshots package-owned compaction input from the current Pi context
2. `createSnapshot()` records validation metadata such as session id, first-kept id, model key, thinking level, and settings key
3. `run()` performs expensive work in the background with an abort signal
4. `toCompaction()` converts package-specific output into a Pi `CompactionResult`

Core still owns timeout/cancel handling, pending/ready/stale state, status display, ready-result apply, `session_before_compact` handoff, and validation. Adapters own prompt format, summary semantics, custom cut policy, details payload, and output validation beyond the core non-empty-summary guard.

This is opt-in infrastructure, not dynamic wrapping. Packages that mutate live session state directly need their own refactor before they can use it safely.

## snapshot contents

A background job records:

- `jobId`
- `sessionId`
- `snapshotLeafId`
- `firstKeptEntryId`
- `modelKey`
- `thinkingLevel`
- `settingsKey` for resolved compaction settings
- `promptVersion`
- generated `CompactionResult`

Applied entries include these fields under `details.asyncPrefixCompaction`, while preserving Pi's compaction details such as `readFiles` and `modifiedFiles` at top level.

## preparation and summary generation

Pi does not currently export `prepareCompaction()`, so the extension mirrors Pi's preparation structure locally using exported primitives:

- `findCutPoint()` for boundary selection
- `getLatestCompactionEntry()` for previous summary/boundary discovery
- `buildSessionContext()` plus usage-aware local token accounting for token counts
- local file-operation extraction matching Pi's `read`/`write`/`edit` handling

The actual summary is generated through the selected typed backend: ChatGPT web by default after explicit login/readiness and async-mode opt-in, or Pi provider compaction with Pi's resolved authentication semantics. Prompt construction is separate from browser automation and preserves Pi's structured checkpoint format, previous-summary update semantics, split-turn summaries, and file-operation tags. The active Pi model and thinking level stay in the snapshot solely for generic validation; the default backend does not resolve provider keys, headers, base URLs, environments, retry settings, or any other Pi model-auth data.

## prefix/tail partition

The background summary covers entries before the snapshotted `firstKeptEntryId`. At apply time the rebuilt context is previewed as:

```text
async summary(snapshot prefix) + current branch messages from firstKeptEntryId onward
```

Messages appended after the snapshot remain raw tail, verbatim and ordered, as long as the current branch still contains both `firstKeptEntryId` and `snapshotLeafId` in the expected order.

## apply validation

Before returning a ready result, the extension validates:

1. no custom `/compact <instructions>` were supplied
2. session id matches
3. active model matches
4. thinking level matches
5. compaction settings match
6. result `firstKeptEntryId` still matches the snapshotted `firstKeptEntryId`
7. current branch contains `firstKeptEntryId`
8. `firstKeptEntryId` is not a `toolResult`
9. current branch contains `snapshotLeafId`
10. `firstKeptEntryId` appears before or at `snapshotLeafId`
11. previewed post-apply context fits under `contextWindow - event.preparation.settings.reserveTokens`

If any check fails, the job becomes stale and Pi falls back to synchronous compaction.

## ready-job replacement

A pending background job sets Pi's adapter-scoped extension status to `<adapter label>: preparing`. When the job becomes ready, the extension attempts to apply it if Pi is idle and has no queued messages. If Pi is actively responding, abortable, has no queued messages, and current usage is over the async threshold, it aborts and triggers Pi compaction. Otherwise the job remains ready and Pi's extension status becomes `<adapter label>: ready`.

A ready job triggers Pi compaction via `ctx.compact()` from a safe boundary (`agent_settled` or immediate background completion while already idle) or from an over-threshold abortable active turn. The active-turn path calls `ctx.abort()` first and records the job id for auto-resume. After `session_compact` confirms Pi persisted that same extension-provided compaction, the extension defers one macrotask and sends `continue` through Pi's public extension API. If compaction does not run immediately or the ready job remains around, it is kept while it still validates and its preview fits. If later turns make the ready summary too large to apply, or session/model/thinking/settings drift makes it unusable, a new `turn_end` crossing supersedes it and starts a replacement background job.

Pending jobs are not replaced; `/async-compact-now` is a no-op while a job is pending. If Pi compacts while a job is pending, the job is staled with `sync_fallback` and Pi compacts synchronously. Automatic and manual jobs use `PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS`, which defaults to five minutes.

## invalidation reasons

Possible reasons:

- `first_kept_missing`
- `first_kept_tool_result`
- `snapshot_leaf_missing`
- `first_kept_after_snapshot`
- `first_kept_mismatch`
- `model_changed`
- `session_changed`
- `thinking_changed`
- `settings_changed`
- `custom_instructions`
- `too_large`
- `superseded`
- `sync_fallback`
- `cancelled`
- `timeout`
- `failed`

## configuration

Environment variables:

```bash
# optional; built-in default is 0.8, use 0.5 to start precomputing around half context
PI_ASYNC_PREFIX_COMPACTION_START_RATIO=0.5
PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=300000
# exact startup opt-in; missing or any other value leaves native Pi compaction untouched
PI_COMPACTION_MODE=async
# web is the default; provider uses Pi model authentication
PI_ASYNC_PREFIX_COMPACTION_BACKEND=web

# stores explicit-login readiness and the dedicated persistent Brave profile
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_STATE_DIR="$HOME/.pi/chatgpt-web-compaction"
# origin must be exactly https://chatgpt.com with no URL credentials; path/query/fragment are allowed
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_URL=https://chatgpt.com/
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_RESPONSE_TIMEOUT_MS=120000
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS=300000
```

The web backend is macOS/Brave-specific; other platforms must use the provider backend. `/chatgpt-web-login` is an experimental two-stage interactive path. It starts the dedicated persistent profile as ordinary headed Brave with only `--user-data-dir`, first-run/default-browser suppression, and Chromium's ordinary `--disable-background-mode` close-window behavior; the user signs in, returns to Pi, and confirms. Pi then gracefully terminates only its owned direct process and waits for bounded profile release before headless verification. The interactive phase has no Playwright, CDP/listening port, AppleScript, or prompt submission. The single `PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS` covers direct login and later verification. A naturally zero-exit direct process also proceeds to verification. Only then does `playwright-core` launch the same profile headlessly, navigate to credential-free exact `https://chatgpt.com`, reject challenge/rate-limit/wrong-origin states, and require structured `/api/auth/session` `user.id`. A structured non-empty id permits a non-secret version-3 `.pi-compaction-ready.json` marker (`0600`) under the private state directory (`0700`); the marker stores only a SHA-256 account binding. This experiment follows a failed headed-Playwright smoke that reached OpenAI redirects and Cloudflare challenges before readiness; it does not bypass those controls.

Ordinary browser compaction requires that marker before Brave launches. `playwright-core` launches the same dedicated profile headlessly with the explicit Brave executable and no listening CDP port. It validates exact ChatGPT origin and the bound live account before composer access, submits once, extracts response-local rendered HTML, and closes its browser context on success, error, or cancellation. Missing/legacy readiness launches nothing; failed/nonzero/timed-out/cancelled direct login never launches verification; session expiry and account mismatch clear readiness and submit nothing. Login and compaction serialize profile access; profile-lock failures are actionable. Browser failures have no provider or headed fallback.

Pi compaction settings remain the source of truth for reserve and keep-recent tokens:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

The extension lifecycle switch is enabled by default; `PI_ASYNC_PREFIX_COMPACTION=0` disables it. Startup mode is nevertheless `normal`, and only exact `PI_COMPACTION_MODE=async` opts into extension work. Runtime mode changes retain the selected async backend for a later switch back. `PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=0` disables both ordinary-job and comparison timeouts.

## limitations

- In-memory only: pending/ready summaries do not survive process restart or `/reload`.
- One job only: pending/ready jobs block new jobs until applied, failed, or staled. ChatGPT login and transport serialize dedicated-Brave profile access through one ownership boundary, and comparison itself is single-flight.
- Preparation mirrors Pi's internal `prepareCompaction()` because it is not exported yet; this should be replaced with the real exported function if Pi exposes it.
- Automatic start requires a non-empty token window: `floor(contextWindow * PI_ASYNC_PREFIX_COMPACTION_START_RATIO) < tokens <= contextWindow - reserveTokens`.
- Ready summaries usually wait for `ctx.isIdle()` and no pending queued messages; an abortable active turn over the async threshold is aborted and compacted like Pi's normal compaction path.
- No metrics service, provider billing integration, or separate status command. Comparison reports contain only per-backend status/duration/output length/error/raw filename and a shared-preparation digest over the full exact input without embedding raw context; raw summaries remain in their separate private Markdown files. Package authors can opt into synchronous structured lifecycle events through `registerAsyncCompaction(..., { onLifecycleEvent })`; see [the adapter guide](./docs/async-compaction-adapters.md#lifecycle-diagnostics).
- Deterministic ChatGPT tests exercise real marker filesystem behavior and an injected Playwright browser boundary, never a real account or browser. UI selector changes, account interstitials, profile locks, and generation completion still need manual headed-login/headless-completion verification. Users must comply with ChatGPT terms; the extension does not bypass authentication, rate limits, or anti-bot controls.
- `customInstructions` forces fallback to normal compaction.

## installation and test commands

Local install:

```bash
pi install .
```

One-off run:

```bash
pi -e .
```

Manual async start:

```text
/async-compact-now
```
