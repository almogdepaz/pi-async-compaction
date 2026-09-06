# async context compaction for Pi coding agent

`pi-async-compaction` is a Pi extension for async context compaction, background compaction, and long-session context management in the Pi coding agent.

Install it with:

```bash
pi install npm:pi-async-compaction
```

## what problem does it solve?

Long Pi coding-agent sessions eventually need context compaction. Normal Pi compaction is correct and Pi-compatible, but it can trigger exactly when the user wants the next turn to continue.

`pi-async-compaction` starts preparing the compaction summary earlier, in the background. When the summary is ready, the extension usually applies it through Pi's normal compaction flow at a safe idle boundary. If an abortable active turn is already over the async threshold, it aborts, compacts, then sends `continue` after Pi persists the compaction.

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

The extension preserves Pi's compaction preparation, validation, and apply lifecycle. Startup defaults to `normal`, blocking extension starts/handoffs and leaving native Pi compaction authoritative. Only exact `PI_COMPACTION_MODE=async` opts in at startup; argument-free `/compaction-mode` opens a cancellable selector, while `/compaction-mode async|normal` remains scriptable. Mode changes stale pending/ready work without changing backend selection.

Its default (`web`) async backend uses the logged-in ChatGPT session from a dedicated Brave profile without resolving Pi model credentials; this path currently requires macOS and Brave. `PI_ASYNC_PREFIX_COMPACTION_BACKEND=provider` instead uses Pi's normal provider authentication and compaction semantics and remains available on other platforms. Before web opt-in, run `/chatgpt-web-login`: this experimental direct-browser flow starts ordinary headed Brave for manual sign-in using the isolated profile only; after sign-in, return to Pi and confirm so it can gracefully terminate only the owned process and wait for bounded profile release before headlessly verifying credential-free exact `https://chatgpt.com` through `playwright-core` and structured `/api/auth/session` data. A naturally zero-exit owned process also proceeds to verification; cancellation never does. Successful verification writes a non-secret version-3 `0600` readiness marker under a private `0700` state directory. The marker binds readiness to a SHA-256 hash of the authorized `user.id`; a different live account submits nothing. Each ordinary web job requires that marker before launching Brave headlessly through `playwright-core`, verifies live auth and exact origin before composer access, sends once, extracts response-local HTML, and closes its browser context on completion, failure, or cancellation. It has no listening CDP port, provider fallback, or headed fallback. Argument-free `/async-compaction-backend` opens a cancellable selector, while `/async-compaction-backend provider|web` switches future jobs and stales pending/ready work.

It avoids applying compaction while queued messages could be reordered. For an over-threshold active turn with no queued messages, this extension aborts first, applies the ready summary, and resumes with a single `continue` message after `session_compact` confirms persistence.

`/async-compact-compare` prepares once, runs provider and web summaries concurrently against that immutable input, and never creates a ready result or applies compaction. It is single-flight, observes the available Pi context abort signal, and uses `PI_ASYNC_PREFIX_COMPACTION_TIMEOUT_MS` to abort stalled work while retaining a completed side. It writes private raw Markdown, facts-only metadata (status, duration, output length, error, raw filenames, and a digest of the full shared preparation without raw context), and escaped CSP-hardened side-by-side HTML under `~/.pi/compaction-comparisons/`. It reports the written path before the nonfatal macOS open attempt.

## links

- Pi package: https://pi.dev/packages/pi-async-compaction
- npm: https://www.npmjs.com/package/pi-async-compaction
- GitHub: https://github.com/almogdepaz/pi-async-compaction
