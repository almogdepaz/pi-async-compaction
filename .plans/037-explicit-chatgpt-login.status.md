# 037 status

- phase: user-approved simplification complete
- branch: `feature/chatgpt-web-compaction`
- base commit: `fb08572`
- current assignment: `ff2e7a06-5aaa-473f-a6b6-0d4e797d1cc7`
- local installation: installed globally from `/Users/home/Dev/pi_compaction`; current sessions require `/reload`

## simplification decision

The user explicitly rejected the prior lifecycle and filesystem threat-model machinery. `fb08572:src/chatgpt-web.ts` is now the complexity baseline, with only the minimum product behavior reapplied.

Kept:
- startup defaults to `normal`; only exact `PI_COMPACTION_MODE=async` opts in.
- explicit headed `/chatgpt-web-login`, command single-flight, optional command-signal abort, and shutdown abort.
- one per-profile serializer shared by login and ordinary web compaction.
- straightforward acquired-context cleanup on abort/finally.
- private `0700` profile and non-secret atomic `0600` readiness marker after structured auth.
- marker gate before browser loading; stale auth clears readiness before composer access.
- credential-free exact `https://chatgpt.com` configured origin, final-page/live-auth checks, and direct pre-fill/pre-send origin checks.
- no provider fallback.

Removed:
- command-owned deadlines and profile-drain protocol.
- late-promise retention, cleanup quarantine, and automatic cleanup state machines.
- filesystem metadata interfaces, no-follow/symlink/mode-validation frameworks, and collision-specific machinery.
- `framenavigated` race state machine and typed trust-violation translation.
- corresponding race, quarantine, drain, symlink, and injected filesystem-failure tests.

## brave browser correction

- replaced Playwright `channel: "chrome"` with Brave executable launch.
- default executable: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`.
- optional override: `PI_ASYNC_PREFIX_COMPACTION_CHATGPT_BROWSER_EXECUTABLE_PATH`.
- retained the dedicated profile, explicit login gate, and safe `normal` startup default.

## interactive Cloudflare correction

- root cause: explicit login treated a visible Cloudflare challenge as fatal, closed Brave, and forced the user into a retry loop.
- explicit headed login now remains open for manual challenge completion until its normal login timeout.
- ordinary background compaction still fails closed on Cloudflare and never attempts bypass behavior.

## duplicate-tab correction

- root cause: persistent Brave already supplied/restored a page, then the extension unconditionally created another.
- login and compaction now reuse the first profile page and close restored extras before navigation.
- focused browser tests: 18 passed, 0 failed; typecheck/check/diff-check passed.

## verification

- last full suite before the duplicate-tab correction: 123 passed, 1 optional parity test skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run check`: passed.
- `git diff --check`: passed.
- `bun install` and `pi install .` succeeded; `pi list` resolves `../../Dev/pi_compaction` to this worktree.
- Brave executable exists and reports `Brave Browser 152.1.94.119`.
- no dedicated-profile Chrome or Brave process is running; readiness marker is absent.
- real authenticated browser/provider smoke was not run; it requires `/reload` followed by explicit user login.
