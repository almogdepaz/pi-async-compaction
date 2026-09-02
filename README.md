# pi async compaction — background context compaction for Pi

[![npm version](https://img.shields.io/npm/v/pi-async-compaction.svg)](https://www.npmjs.com/package/pi-async-compaction)
[![Pi package](https://img.shields.io/badge/pi-package-6f42c1)](https://pi.dev/packages/pi-async-compaction)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Async context compaction for the Pi coding agent: keep long Pi coding sessions responsive by precomputing background compaction summaries.

```bash
pi install npm:pi-async-compaction
```

Async compaction prepares Pi-compatible compaction summaries before you hit the limit, then applies a ready summary through Pi's normal compaction flow. If an abortable active turn is already over the async threshold, it aborts, compacts, then automatically sends `continue` once Pi persists the compaction.

> **privacy:** automatic compaction uploads the serialized conversation being compacted, previous summaries, and tool output to the logged-in ChatGPT account. Do not enable this backend for sensitive sessions unless that transfer is acceptable.

## why install it

- less waiting when context gets large
- ChatGPT web summaries using a dedicated, logged-in Chrome profile; no Pi model credentials are used for async summaries
- safe idle apply, plus abort-and-compact with auto-resume when an active turn is already over the async threshold
- status-line visibility while a background job is pending or ready
- manual `/compact` and Pi's normal threshold/overflow compaction still work

Best for long coding sessions, repo audits, multi-file edits, and context-heavy work where synchronous compaction tends to land at the worst possible moment.

## normal compaction vs async compaction

| normal Pi compaction | async compaction |
| --- | --- |
| waits to summarize when compaction is triggered | prepares the summary earlier in the background |
| can land right before your next turn continues | usually applies at an idle boundary; over the async threshold it can abort, compact, and auto-resume |
| uses Pi's built-in compaction behavior | uses an authenticated ChatGPT web session while preserving Pi's preparation, validation, and apply lifecycle |
| visible as a synchronous pause | visible as a quiet status-line job |

## install

From npm:

```bash
pi install npm:pi-async-compaction
```

From git:

```bash
pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.8
```

Local development:

```bash
bun install
pi install .
```

or test for one run:

```bash
bun install
pi -e .
```

## demo

![pi async compaction preview](media/social-preview.png)

When the context crosses the async start window, the extension starts a background summary and keeps chat output quiet:

```text
status: ChatGPT web compaction: preparing
```

When the summary is ready but Pi is below the async threshold, not abortable, or has queued messages, it waits instead of interrupting the active turn:

```text
status: ChatGPT web compaction: ready
```

At the next safe idle boundary, Pi's normal compaction flow consumes the ready summary and the extension emits a compact notification:

```text
Applied ready ChatGPT web compaction
```

The static preview above is also used for the pi.dev package gallery.

## how it works

Async compaction precomputes summaries early, then applies them only at a safe boundary:

1. after a turn, if context usage crosses the async start threshold, a background summary starts
2. the background job reuses Pi's preparation and sends its structured checkpoint prompt to a fresh ChatGPT web chat; it never resolves Pi provider credentials
3. when the summary is ready, the extension applies it immediately if Pi is idle and has no queued messages
4. if Pi is actively responding, abortable, has no queued messages, and is still over the async threshold, it aborts and triggers Pi compaction
5. after Pi persists that extension-provided compaction, the extension sends `continue` to resume work
6. otherwise the ready summary is kept for later and Pi's status bar shows `<adapter label>: ready`; at Pi's next `agent_settled` event, the extension applies it if no messages are queued
7. Pi fires `session_before_compact`; if the ready async summary validates, the extension returns it
8. otherwise Pi falls back to normal synchronous compaction

Manual `/compact` and Pi's normal threshold/overflow compaction can also use a ready async summary.

Manual trigger, bypassing the early-start threshold:

```text
/async-compact-now
```

## backends and comparison

The default mode is `async`. Set `PI_COMPACTION_MODE=normal` or run `/compaction-mode normal` to disable all extension job starts and handoffs, leaving native Pi compaction untouched. `/compaction-mode async` restores extension behavior. Mode changes stale pending or ready work but do not alter the selected backend.

The default async backend is `web`, which uses the authenticated ChatGPT browser profile and never resolves Pi provider credentials. Select `provider` to use Pi's normal model authentication and compaction request semantics instead:

```bash
PI_ASYNC_PREFIX_COMPACTION_BACKEND=provider
```

At runtime, switch future jobs with `/async-compaction-backend provider` or `/async-compaction-backend web`. Switching stales pending or ready work; backend selection and its prompt-version correlation are snapshotted at job start under one generic async-compaction identity.

Run `/async-compact-compare` to prepare once and send that exact compacted context concurrently to both backends. Neither result enters the ready/apply lifecycle or changes the session. One comparison runs at a time and uses `PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS`; timeout or cancellation preserves any completed side. The command writes private (`0700` directory, `0600` files) provider/web raw Markdown, facts-only metadata (status, duration, output length, error, raw filename, and a digest of the full shared preparation; no raw context), and a CSP-hardened escaped side-by-side HTML report under `~/.pi/compaction-comparisons/`. It notifies the report path before macOS attempts to open it; opener failures are warnings. Comparison explicitly sends the compacted context to both your configured provider and logged-in ChatGPT account.

## for compaction package authors (experimental)

If your package currently does slow work inside `session_before_compact`, use `pi-async-compaction/core` to run that work in the background and hand off a ready `CompactionResult` later.

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";
import type { AsyncCompactionAdapter } from "pi-async-compaction/core";

const adapter: AsyncCompactionAdapter<MyPreparedSnapshot, MySummaryResult> = {
  id: "my-compactor",
  label: "my compactor",
  prepare: ({ ctx, settings }) => snapshotCompactionInput(ctx, settings),
  createSnapshot: ({ ctx, jobId, prepared, settings }) => makeValidationSnapshot(ctx, jobId, prepared, settings),
  run: ({ prepared, signal }) => summarizeInBackground(prepared, signal),
  toCompaction: ({ prepared, result }) => toPiCompactionResult(prepared, result),
};

export default function myExtension(pi) {
  registerAsyncCompaction(pi, adapter, { commandName: "my-async-compact-now" });
}
```

Your package still owns the summary format, model calls, custom cut policy, and `details` payload. `pi-async-compaction` owns lifecycle: threshold start, pending/ready/stale state, timeout/cancel, status line, ready-result apply, and final `session_before_compact` handoff.

Full guide: [docs/async-compaction-adapters.md](docs/async-compaction-adapters.md).

## FAQ

### How do I make Pi compaction async?

Install `pi-async-compaction`:

```bash
pi install npm:pi-async-compaction
```

The extension precomputes Pi-compatible compaction summaries in the background and applies them through Pi's normal compaction flow when safe.

### Is there a Pi extension for background compaction?

Yes. `pi-async-compaction` is a Pi extension for background context compaction, async context compaction, and precomputed compaction summaries.

### Does async compaction replace Pi's normal compaction?

No. It preserves Pi's normal compaction behavior. Manual `/compact`, threshold compaction, and overflow compaction still work.

### Does it interrupt active turns?

Usually no. If an abortable active turn is already over the async threshold, the extension aborts, compacts, then automatically sends `continue` after Pi persists the compaction.

### What should agents search for?

Relevant phrases: Pi async compaction, Pi background compaction, async context compaction for Pi, Pi context compaction extension, Pi coding agent compaction extension, background context compaction for Pi, context management for Pi coding agent.

See also [docs/async-context-compaction.md](docs/async-context-compaction.md) and [llms.txt](llms.txt).

## env config and ChatGPT login

```bash
# optional; built-in default is 0.8, use 0.5 to start precomputing around half context
PI_ASYNC_PREFIX_COMPACTION_START_RATIO=0.5
PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=300000
# optional; web is the default, provider uses Pi model authentication
PI_ASYNC_PREFIX_COMPACTION_BACKEND=web

# optional ChatGPT web backend settings
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_PROFILE_DIR="$HOME/.pi/chatgpt-web-compaction"
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_URL=https://chatgpt.com/
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_RESPONSE_TIMEOUT_MS=120000
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS=300000
# set to 1 only for debugging; headed system Chrome is the default
PI_ASYNC_PREFIX_COMPACTION_CHATGPT_HEADLESS=0
```

Run `/async-compact-now` once to open the headed system Chrome window and log in to ChatGPT. The job waits for login for `PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS` (five minutes by default), then sends its compaction request; the dedicated persistent profile retains that login. Each job opens a fresh temporary chat and closes the browser context after its response. The default headed launch is `chromium.launchPersistentContext(profile, { channel: "chrome", headless: false })`; headless mode is opt-in because it can trigger Cloudflare verification.

The extension is enabled by default; set `PI_ASYNC_PREFIX_COMPACTION=0` to disable. Reserve and keep-recent tokens come from Pi's normal `compaction` settings. Automatic background jobs only start when `floor(contextWindow * PI_ASYNC_PREFIX_COMPACTION_START_RATIO) < tokens <= contextWindow - reserveTokens`; if that window is empty, use a larger context model, lower the start ratio, or lower Pi's reserve tokens. Pi's normal compaction threshold remains `contextWindow - reserveTokens`; the async start ratio controls both how early the background summary is prepared and when a ready summary may abort-and-compact an active turn.

### ChatGPT failure semantics and risks

The browser backend does not call `ctx.modelRegistry.getApiKeyAndHeaders()` and never falls back to Pi provider usage. Login-required, Cloudflare, rate-limit, selector-change, empty, incomplete, stalled, abort, and timeout failures mark only the async job failed or stale; Pi's independent native `/compact` and threshold compaction remain available. This automation must comply with ChatGPT terms and account policy; it does not attempt to bypass login, rate limits, or anti-bot controls.

Deterministic tests cover prompt, result, and conversion helpers; real selectors, session checks, and UI behavior require manual headed-Chrome verification. They are **not** exercised against a real logged-in ChatGPT account in CI: UI/accessibility changes, account-specific interstitials, Cloudflare, and generation completion behavior require manual headed-Chrome verification after upgrades.

## lifecycle diagnostics

Package authors using `pi-async-compaction/core` can measure lifecycle behavior without enabling a telemetry service. Pass an observer when registering the adapter:

```ts
import { registerAsyncCompaction } from "pi-async-compaction/core";
import type { AsyncCompactionLifecycleEvent } from "pi-async-compaction/core";

const observe = (event: AsyncCompactionLifecycleEvent): void => {
  console.info(JSON.stringify(event));
};

registerAsyncCompaction(pi, adapter, { onLifecycleEvent: observe });
```

Events are `started`, `ready`, `handed_off`, `invalidated`, and `failed`. Every event identifies the adapter and job; terminal events carry `durationMs`. Invalidations and failures include a `wastedWork` confidence (`possible` or `confirmed`), rather than a cost estimate. The observer is synchronous and opt-in: keep it cheap, avoid recording prompts or summaries, and do not treat duration or wasted-work confidence as provider billing. Observer exceptions are isolated from compaction and reported with `console.warn`.

## roadmap

- add a real terminal gif for the demo section
- apply before the next top-level prompt if Pi exposes a clean pre-prompt extension hook
- upstream/request a non-aborting compaction-apply hook for queued steering/follow-up boundaries

## development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
```

This package is tested against Pi `0.84.3` and `0.84.4`. Its declared peer range is `>=0.84.3 <0.85.0`; Pi provides the core packages at runtime.

## changelog

See [CHANGELOG.md](CHANGELOG.md).
