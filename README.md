# pi async compaction — background context compaction for Pi

[![npm version](https://img.shields.io/npm/v/pi-async-compaction.svg)](https://www.npmjs.com/package/pi-async-compaction)
[![Pi package](https://img.shields.io/badge/pi-package-6f42c1)](https://pi.dev/packages/pi-async-compaction)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Keep long Pi coding sessions responsive by precomputing context compaction in the background.

```bash
pi install npm:pi-async-compaction
```

Async compaction prepares Pi-compatible compaction summaries before you hit the limit, then applies a ready summary through Pi's normal compaction flow when it is safe. No surprise active-turn interruption, no shortened summaries, no custom context format.

## why install it

- less waiting when context gets large
- Pi-compatible summaries generated with Pi's exported compaction logic
- safe apply only when Pi is idle and no queued messages would be reordered
- status-line visibility while a background job is pending or ready
- manual `/compact` and Pi's normal threshold/overflow compaction still work

Best for long coding sessions, repo audits, multi-file edits, and context-heavy work where synchronous compaction tends to land at the worst possible moment.

## normal compaction vs async compaction

| normal Pi compaction | async compaction |
| --- | --- |
| waits to summarize when compaction is triggered | prepares the summary earlier in the background |
| can land right before your next turn continues | applies a ready summary only at a safe idle boundary |
| uses Pi's built-in compaction behavior | also uses Pi's built-in compaction behavior |
| visible as a synchronous pause | visible as a quiet status-line job |

## install

From npm:

```bash
pi install npm:pi-async-compaction
```

From git:

```bash
pi install git:github.com/almogdepaz/pi-async-compaction@v0.1.2
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

When the context crosses the async start window, the extension starts a background summary and keeps chat output quiet:

```text
status: async_compaction ...
```

When the summary is ready but Pi is still busy or has queued messages, it waits instead of interrupting the active turn:

```text
status: async_compaction ready
```

At the next safe idle boundary, Pi's normal compaction flow consumes the ready summary and the extension emits a compact notification:

```text
Applied ready async compaction
```

A real screenshot/gif would help here; none is included yet because fake demo media is worse than no demo media.

## how it works

Async compaction precomputes summaries early, then applies them only at a safe boundary:

1. after a turn, if context usage crosses the async start threshold, a background summary starts
2. the background job reuses Pi's compaction preparation/generation behavior so the summary stays Pi-compatible
3. when the summary is ready, the extension applies it immediately only if Pi is idle and has no queued messages
4. if Pi is still responding or has queued follow-up/steering messages, the ready summary is kept for later and Pi's status bar shows `async_compaction ready`
5. after `agent_end`, including an Escape-cancelled turn, the extension retries applying the ready summary once Pi has settled idle and no queued messages remain
6. Pi fires `session_before_compact`; if the ready async summary validates, the extension returns it
7. otherwise Pi falls back to normal synchronous compaction

Manual `/compact` and Pi's normal threshold/overflow compaction can also use a ready async summary.

Manual trigger, bypassing the early-start threshold:

```text
/async-compact-now
```

## env config

```bash
# optional; built-in default is 0.8, use 0.5 to start precomputing around half context
PI_ASYNC_PREFIX_COMPACTION_START_RATIO=0.5
PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS=300000
```

The extension is enabled by default; set `PI_ASYNC_PREFIX_COMPACTION=0` to disable. Reserve and keep-recent tokens come from Pi's normal `compaction` settings. Automatic background jobs only start when `floor(contextWindow * START_RATIO) < tokens <= contextWindow - reserveTokens`; if that window is empty, use a larger context model, lower the start ratio, or lower Pi's reserve tokens. Pi's normal compaction threshold remains `contextWindow - reserveTokens`, so the async start ratio only controls how early the background summary is prepared.

## roadmap

- add a real terminal gif/screenshot for the demo section
- improve safe-apply retry behavior when Pi takes longer than one tick to settle idle
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

This package is tested against Pi `0.80.3`. The Pi core packages are declared as peer dependencies because Pi provides them at runtime.

## changelog

See [CHANGELOG.md](CHANGELOG.md).
