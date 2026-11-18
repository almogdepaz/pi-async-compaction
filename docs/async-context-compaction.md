# async context compaction for Pi coding agent

`pi-async-compaction` is a Pi extension for async context compaction, background compaction, and long-session context management in the Pi coding agent.

Install it with:

```bash
pi install npm:pi-async-compaction
```

## what problem does it solve?

Long Pi coding-agent sessions eventually need context compaction. Normal Pi compaction is correct and Pi-compatible, but it can trigger exactly when the user wants the next turn to continue.

`pi-async-compaction` starts preparing the compaction summary earlier, in the background. On legacy patched Astra hosts, a ready result requests a non-aborting checkpoint after the current turn and before queued steering or follow-up delivery. Stock Pi `1.0.0` does not expose that legacy checkpoint. Otherwise it applies through Pi's normal idle flow; if the checkpoint is unavailable or rejects and an active turn is already over the async threshold, it proposes the ready summary as a `turn_end` compaction draft at the next completed turn boundary that continues. It never aborts the active turn and sends no `continue` message.

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

The patched-host checkpoint preserves queued-message ordering while applying compaction before the next provider turn. For hosts without that checkpoint, an over-threshold active turn applies the ready summary at a completed, non-cancelled `turn_end` that continues. Pi commits the draft before the next provider call. Because Pi emits no `session_compact` event for such a draft, the extension confirms persistence from the branch at the next lifecycle event. A final reply applies after `agent_settled`.

## links

- Pi package: https://pi.dev/packages/pi-async-compaction
- npm: https://www.npmjs.com/package/pi-async-compaction
- GitHub: https://github.com/almogdepaz/pi-async-compaction
