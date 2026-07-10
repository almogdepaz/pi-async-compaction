# pi async prefix compaction

Pi extension that precomputes compaction summaries in the background, then applies a ready summary through Pi's normal compaction flow when the agent is idle or when Pi triggers `/compact`/auto-compaction.

## install

From npm:

```bash
pi install npm:pi-async-prefix-compaction
```

From git:

```bash
pi install git:github.com/almogdepaz/pi_compaction@v0.1.0
```

Local development:

```bash
pi install .
```

or test for one run:

```bash
pi -e .
```

## usage

Async compaction precomputes summaries early, then applies them only at a safe boundary:

- background summary starts after a turn when context crosses the async start threshold
- when the summary is ready, the extension applies it immediately only if Pi is idle and has no queued messages
- if Pi is still responding or has queued follow-up/steering messages, the ready summary is kept for later and Pi's status bar shows `async_compaction ready`
- after `agent_end`, including an Escape-cancelled turn, the extension retries applying the ready summary once Pi has settled idle and no queued messages remain
- Pi fires `session_before_compact`; if the ready async summary validates, the extension returns it
- otherwise Pi falls back to normal synchronous compaction

Manual `/compact` and Pi's normal threshold/overflow compaction still work and can also use a ready async summary.

While a background summary is running, Pi's status bar shows `async_compaction ...`. The extension clears that status when the background job applies, fails, or is invalidated; if a ready summary is waiting for a safe idle boundary, it shows `async_compaction ready`.

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

## development

```bash
bun install
bun test
bun run typecheck
bun run check
bun pm pack --dry-run
```

This package is tested against Pi `0.80.3`. The Pi core packages are declared as peer dependencies because Pi provides them at runtime.
