# 038 status

- phase: implementation, live smoke, verification, and local installation complete
- branch: `feature/chatgpt-web-compaction`
- base: current uncommitted 037 worktree
- reviewer session: `dedeacbe-41f3-44cf-9b72-86ed5cd42d91` (acknowledged and closed)
- implementation: Playwright removed; normal-Brave AppleScript boundary lives in `src/chatgpt-brave.ts`; web lifecycle remains in `src/chatgpt-web.ts`
- ownership: each login or completion uses one `osascript` process that opens the direct ChatGPT URL, retains its created tab reference, performs all page actions, and closes that reference before returning
- readiness: version 2 marker is bound to SHA-256 of structured ChatGPT `user.id`; legacy markers fail before browser invocation; account mismatch and expired auth clear readiness before submission
- input/output: prompt-bearing JavaScript uses private `0700` temporary directories and `0600` files; the prompt and rendered HTML cross the boundary as base64 and never use process arguments, AppleScript source, or the clipboard
- abort: a private cancellation file gives the owning AppleScript time to close its tab before SIGTERM/SIGKILL escalation
- deterministic focused verification: 18 passed, 0 failed; typecheck, source syntax check, diff check, ASCII-only AppleScript assertion, AppleScript compilation, and static JavaScript parsing passed
- final repository verification: 124 passed, 1 optional parity test skipped, 0 failed; typecheck, source syntax, release check, diff check, package dry-run, AppleScript compilation, static JavaScript parsing, and forbidden-boundary scans passed
- installation: `bun install --frozen-lockfile` reported no changes; `pi install .` succeeded; `pi list` resolves `/Users/home/Dev/pi_compaction`
- live authentication: passed against the authenticated normal Brave profile; structured SHA-256 readiness marker written with mode `0600`; owned tab closed
- live completion: passed in one temporary chat with harmless prompt; extracted Markdown was exactly `## Smoke\n\nok`; owned tab closed before subprocess success
- live Pi integration: user confirmed `/async-compaction-backend web`, async mode, and `/async-compact-now` completed successfully end to end
- remote debugging: confirmed off before both successful live probes
- remaining: reload the extension in existing Pi sessions before using the installed implementation; commit/push only when explicitly requested
