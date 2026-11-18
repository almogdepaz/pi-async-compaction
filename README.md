# pi async compaction — background context compaction for Pi

[![npm version](https://img.shields.io/npm/v/pi-async-compaction.svg)](https://www.npmjs.com/package/pi-async-compaction)
[![Pi package](https://img.shields.io/badge/pi-package-6f42c1)](https://pi.dev/packages/pi-async-compaction)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Async context compaction for the Pi coding agent: keep long Pi coding sessions responsive by precomputing background compaction summaries.

```bash
pi install npm:pi-async-compaction
```

Async compaction prepares Pi-compatible compaction summaries before you hit the limit, then applies a ready summary through Pi's normal compaction flow. If an active turn is already over the async threshold, it hands the summary to Pi at the next completed turn boundary that continues, so the active model or tool work is never aborted and no `continue` message is sent.

## why install it

- less waiting when context gets large
- Pi-compatible summaries generated with Pi's exported compaction logic
- safe idle apply, plus non-aborting apply at a continuing turn boundary when an active turn is already over the async threshold
- status-line visibility while a background job is pending or ready
- manual `/compact` and Pi's normal threshold/overflow compaction still work

Best for long coding sessions, repo audits, multi-file edits, and context-heavy work where synchronous compaction tends to land at the worst possible moment.

## normal compaction vs async compaction

| normal Pi compaction | async compaction |
| --- | --- |
| waits to summarize when compaction is triggered | prepares the summary earlier in the background |
| can land right before your next turn continues | applies at an idle boundary, or over the async threshold at a completed continuing turn boundary, without aborting |
| uses Pi's built-in compaction behavior | also uses Pi's built-in compaction behavior |
| visible as a synchronous pause | visible as a quiet status-line job |

## install

From npm:

```bash
pi install npm:pi-async-compaction
```

From git:

```bash
pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.10
```

Local development:

```bash
pi install .
```

or test for one run:

```bash
pi -e .
```

## demo

![pi async compaction preview](media/social-preview.png)

When the context crosses the async start window, the extension starts a background summary and keeps chat output quiet:

```text
status: built-in Pi compaction: preparing
```

When the summary is ready while Pi is still working, it waits instead of interrupting the active turn:

```text
status: built-in Pi compaction: ready
```

At the next safe idle boundary, Pi's normal compaction flow consumes the ready summary and the extension emits a compact notification:

```text
Applied ready built-in Pi compaction
```

The static preview above is also used for the pi.dev package gallery.

## how it works

Async compaction precomputes summaries early, then applies them only at a safe boundary:

1. after a turn, if context usage crosses the async start threshold, a background summary starts
2. the background job reuses Pi's compaction preparation/generation behavior so the summary stays Pi-compatible
3. when the summary is ready, the extension applies it immediately if Pi is idle and has no queued messages
4. if Pi is actively responding and still over the async threshold, the extension proposes the ready summary as a Pi `turn_end` compaction draft at the next completed, non-cancelled turn that continues with tool results, a follow-up or queued messages; Pi commits it before the next provider call, without aborting
5. otherwise the ready summary is kept for later and Pi's status bar shows `<adapter label>: ready`; at Pi's next `agent_settled` event, the extension applies it if no messages are queued
6. Pi fires `session_before_compact`; if the ready async summary validates, the extension returns it
7. otherwise Pi falls back to normal synchronous compaction

Manual `/compact` and Pi's normal threshold/overflow compaction can also use a ready async summary.

Branches with active context edits use Pi's normal synchronous compaction. A context edit also invalidates any previously prepared summary, so omitted or replaced raw content cannot be applied from that summary. Async preparation resumes after compaction moves past those edits.

Manual trigger, bypassing the early-start threshold:

```text
/async-compact-now
```

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

No. A ready summary never aborts active model or tool work. An active turn already over the async threshold receives the summary at the next completed turn boundary that continues; a final reply receives it after the agent settles. No `continue` message is sent.

### What should agents search for?

Relevant phrases: Pi async compaction, Pi background compaction, async context compaction for Pi, Pi context compaction extension, Pi coding agent compaction extension, background context compaction for Pi, context management for Pi coding agent.

See also [docs/async-context-compaction.md](docs/async-context-compaction.md) and [llms.txt](llms.txt).

## env config

```bash
# optional; built-in default is 0.8, use 0.5 to start precomputing around half context
PI_ASYNC_PREFIX_COMPACTION_START_RATIO=0.5
PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=300000
```

The extension is enabled by default; set `PI_ASYNC_PREFIX_COMPACTION=0` to disable. Reserve and keep-recent tokens come from Pi's normal `compaction` settings. Automatic background jobs only start when `floor(contextWindow * START_RATIO) < tokens <= contextWindow - reserveTokens`; if that window is empty, use a larger context model, lower the start ratio, or lower Pi's reserve tokens. Pi's normal compaction threshold remains `contextWindow - reserveTokens`; the async start ratio controls both how early the background summary is prepared and when a ready summary may apply at an active turn boundary.

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

This package supports Pi 1.x from `1.3.0` (peers `^1.3.0`); Pi provides the core packages at runtime. CI tests Pi `1.3.0`, `1.4.0`, `1.5.0`, and the newest Pi release. Older Pi `0.84.3`–`0.84.4` hosts should keep `pi-async-compaction@0.1.8`.

## changelog

See [CHANGELOG.md](CHANGELOG.md).
