# async compaction design

This Pi extension precomputes Pi-compatible compaction summaries in the background when compaction mode is `async` (the default), usually waits for a safe idle boundary before triggering Pi's compaction flow, and supplies the ready summary through Pi's normal compaction hook. `normal` mode starts and hands off no extension work, leaving native Pi compaction untouched. If a ready result exists during an abortable active turn over the async threshold, it follows Pi's normal compaction behavior by aborting before compacting.

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

The actual summary is generated through the selected typed backend: ChatGPT web by default, or Pi provider compaction with Pi's resolved authentication semantics. Prompt construction is separate from browser automation and preserves Pi's structured checkpoint format, previous-summary update semantics, split-turn summaries, and file-operation tags. The active Pi model and thinking level stay in the snapshot solely for generic validation; the default backend does not resolve provider keys, headers, base URLs, environments, retry settings, or any other Pi model-auth data.

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
# async is the default; normal leaves native Pi compaction untouched
PI_COMPACTION_MODE=async
# web is the default; provider uses Pi model authentication
PI_ASYNC_PREFIX_COMPACTION_BACKEND=web

# headed system Chrome is the default; log in once in this dedicated profile
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_PROFILE_DIR="$HOME/.pi/chatgpt-web-compaction"
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_URL=https://chatgpt.com/
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_RESPONSE_TIMEOUT_MS=120000
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS=300000
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_HEADLESS=0
```

The browser opens a fresh temporary chat for each request and closes its context on completion or abort. A headed manual `/async-compact-now` job waits for one-time login up to `PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS`; `PI_ASYNC_PREFIX_COMPACTION_CHATGPT_HEADLESS=1` is diagnostic-only because headless ChatGPT is known to trigger Cloudflare on the supported macOS setup. Login, Cloudflare, rate-limit, selector-change, empty/incomplete response, abort, and browser timeout failures fail or stale only the async job; they never fall back to Pi provider authentication. Pi's native compaction remains independent.

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

The extension is enabled by default; `PI_ASYNC_PREFIX_COMPACTION=0` disables it. `PI_COMPACTION_MODE=normal` separately leaves native Pi compaction authoritative while retaining the selected async backend for a later switch back. `PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=0` disables both ordinary-job and comparison timeouts.

## limitations

- In-memory only: pending/ready summaries do not survive process restart or `/reload`.
- One job only: pending/ready jobs block new jobs until applied, failed, or staled. ChatGPT transport serializes persistent-profile access, and comparison itself is single-flight.
- Preparation mirrors Pi's internal `prepareCompaction()` because it is not exported yet; this should be replaced with the real exported function if Pi exposes it.
- Automatic start requires a non-empty token window: `floor(contextWindow * PI_ASYNC_PREFIX_COMPACTION_START_RATIO) < tokens <= contextWindow - reserveTokens`.
- Ready summaries usually wait for `ctx.isIdle()` and no pending queued messages; an abortable active turn over the async threshold is aborted and compacted like Pi's normal compaction path.
- No metrics service, provider billing integration, or separate status command. Comparison reports contain only per-backend status/duration/output length/error/raw filename and a shared-preparation digest over the full exact input without embedding raw context; raw summaries remain in their separate private Markdown files. Package authors can opt into synchronous structured lifecycle events through `registerAsyncCompaction(..., { onLifecycleEvent })`; see [the adapter guide](./docs/async-compaction-adapters.md#lifecycle-diagnostics).
- The ChatGPT web flow is not run against a real account in CI. UI/accessibility selector changes, account interstitials, Cloudflare, and generation completion need manual headed-Chrome verification. Users must comply with ChatGPT terms; the extension does not bypass authentication, rate limits, or anti-bot controls.
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
