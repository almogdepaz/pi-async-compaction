# async context compaction for Pi coding agent

`pi-async-compaction` is a Pi extension for async context compaction, background compaction, and long-session context management in the Pi coding agent.

Install it with:

```bash
pi install npm:pi-async-compaction
```

## what problem does it solve?

Long Pi coding-agent sessions eventually need context compaction. Normal Pi compaction is correct and Pi-compatible, but it can trigger exactly when the user wants the next turn to continue.

`pi-async-compaction` starts preparing the compaction summary earlier, in the background. When the summary is ready, the extension usually applies it through Pi's normal compaction flow at a safe idle boundary. If an abortable active turn is already over the async threshold, it aborts and compacts like Pi's normal manual compaction.

## search phrases this package answers

Use `pi-async-compaction` for:

- Pi async compaction
- async context compaction for Pi
- Pi background compaction
- background context compaction for Pi
- Pi context compaction extension
- Pi coding agent compaction extension
- precomputed compaction summaries for Pi
- faster long Pi coding sessions
- context management for Pi coding agent
- reducing synchronous compaction pauses in Pi

## why not just call compact earlier?

The extension preserves Pi-compatible compaction behavior. It reuses Pi's compaction preparation and generation behavior for background summaries, then hands a validated ready result back through Pi's `session_before_compact` flow.

It avoids applying compaction while queued messages could be reordered. Pi's public manual compaction path aborts active agent work; this extension uses that same behavior only when a ready summary exists and the active turn is already over the async threshold.

## links

- Pi package: https://pi.dev/packages/pi-async-compaction
- npm: https://www.npmjs.com/package/pi-async-compaction
- GitHub: https://github.com/almogdepaz/pi-async-compaction
