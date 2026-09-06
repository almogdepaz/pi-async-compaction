# 039 headless ChatGPT web profile and interactive controls

status: direct-browser login succeeded interactively; headless verification blocked by Cloudflare 403

- implementer session: `c811c7c0-ec16-4092-926a-d0e455e5d909`
- implementer task: `4fe95c4b-1b8a-43a7-8849-73b92bb8a58b`
- correction task: `c81d0215-4600-4cc3-8dcc-69abdee6860a`
- generation-state correction task: `a836c6ba-aed4-49dc-98fa-722bd3f25879`
- direct-browser login experiment task: `aa08f1ad-8972-47c8-867e-e98bd7cc7259`
- direct-browser lifecycle correction task: `88188289-8271-4662-a3c7-8b3553deffa2`
- Pi-confirmed login correction task: `bce562d1-8c0b-4988-9737-8e06346b0bd1`
- Pi-confirmed login review task: `4aba7605-dbf0-45ed-a13f-a8086da103a7`
- confirmation cleanup task: `ed1e9f41-b931-4667-8cce-1a2ca9c5c064`
- confirmation cleanup review task: `d9ecab1f-4f6d-46c6-afb7-0a31461a1e86`
- reviewer session: `8eb1cb02-f560-4bb5-af7f-79ae79949663`
- reviewer task: `b74331ef-b799-47fe-a764-db32e7f16168`
- reviewer finding-report task: `58f827a9-3982-4128-861f-e590c208696c`
- correction review task: `e42353bb-84b7-4037-8c88-c3b86b5ea4d5`
- final correction review task: `f5d4f0a0-075e-4623-9048-dfa45f47f960`
- direct-browser experiment review task: `c806b338-2edc-4d5d-99e4-8b657ef5f21a`
- direct-browser lifecycle final review task: `597ea057-c984-407b-9b31-3817e92a6216`

## implementation status

- complete: `playwright-core` now launches the isolated persistent Brave profile headed only for `/chatgpt-web-login` and headlessly for ordinary completion; marker version 3 binds the verified ChatGPT account and rejects legacy normal-profile authorization before launch.
- complete: web completion validates readiness, exact origin, and account before composer access; profile serialization, lock errors, cancellation, and browser-context cleanup fail closed without provider or headed fallback.
- complete: argument-free `/compaction-mode` and `/async-compaction-backend` now use cancellable Pi selectors; explicit arguments and direct action commands are unchanged.
- complete: AppleScript transport surface removed and documentation updated.
- verified focused: red/green `bun test test/chatgpt-web-login.test.ts` and `bun test test/index.test.ts`; focused typecheck `bunx tsc --noEmit --strict --moduleResolution Bundler --module ESNext --target ES2022 --skipLibCheck --types node --types bun src/chatgpt-web.ts src/index.ts test/chatgpt-web-login.test.ts test/index.test.ts`; final focused `bun test test/chatgpt-compaction.test.ts test/chatgpt-web-login.test.ts test/index.test.ts test/backend-comparison.test.ts` (52 pass).
- review corrections complete: headed login now tolerates a challenge while polling structured authentication; headless completion fails closed on a challenge. Browser automation is isolated in `src/chatgpt-brave.ts`, reuses the persistent context's initial page, fails closed for active/unknown streaming state, wraps launch failure generically with its cause, and validates an automation account hash before marker persistence.
- verified correction-focused: red `bun test test/chatgpt-brave.test.ts` failed because `src/chatgpt-brave.ts` did not yet exist; red `bun test test/chatgpt-web-login.test.ts --test-name-pattern malformed` failed because malformed automation data created readiness. green `bun test test/chatgpt-brave.test.ts test/chatgpt-web-login.test.ts test/chatgpt-compaction.test.ts` (23 pass); focused `tsc`, `bun --check` on the three ChatGPT modules, and `git diff --check` pass.
- generation-state correction complete: the response-local streaming/status observer now recognizes active (`true`, `in_progress`, `in-progress`) and finished (`false`, `finished`, `complete`, `completed`) values. A global structured stop button is tracked separately; its observed disappearance can establish idle only after positive active evidence. Missing or failed inspection stays fail-closed. Tests execute the browser evaluation callback for active→idle, explicit finished, inspection failure/no evidence, and unrelated stale markers. `getChatGptAccountId` is now the shared structured-session parser.
- verified generation-state correction: red `bun test test/chatgpt-brave.test.ts` produced 3 expected completion failures under the old observer; green `bun test test/chatgpt-brave.test.ts test/chatgpt-web-login.test.ts test/chatgpt-compaction.test.ts` (26 pass), full `bun run typecheck`, `bun run check`, and `git diff --check` pass.
- final reviewer verdict: approved with no remaining blocker or important issue in the corrected browser surface.
- final offline gate: `bun test` (135 pass, 1 optional parity test skipped, 0 fail), `bun run typecheck`, `bun run check`, `bun run release:check`, `git diff --check`, and `bun pm pack --dry-run --ignore-scripts` (27 expected files) pass; generated archive removed.
- live headed login: failed before readiness. The new dedicated profile reached sanitized `https://auth.openai.com/email-verification`, then `https://auth.openai.com/` (user observed 404), followed by repeated Cloudflare challenges; the polled page/context closed. No readiness marker, browser process, or prompt remains.
- live headless completion and `/async-compact-now`: not run because authentication did not establish version-3 readiness; continuing would fail before prompt submission.
- prior headed-Playwright blocker: dedicated Playwright-launched Brave authentication reproduced external OpenAI redirect/Cloudflare failure. No anti-bot bypass will be attempted.
- direct-browser experiment complete: `/chatgpt-web-login` now launches its dedicated profile as an owned ordinary headed Brave process (`--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, `--disable-background-mode`), asks the user to sign in and confirm in Pi, terminates only that owned process with bounded escalation, then headlessly verifies exact ChatGPT origin and structured session. The single timeout and serialization cover both stages; direct nonzero/spawn error/timeout/cancellation prevents verification and readiness.
- verified direct-browser experiment: red direct-browser/login-status regressions failed before implementation; green `bun test test/chatgpt-brave.test.ts test/chatgpt-web-login.test.ts test/chatgpt-compaction.test.ts test/index.test.ts` (55 pass), `bun run typecheck`, `bun run check`, and `git diff --check` pass. Live direct-login/headless-verification smoke remains parent-owned.
- direct-browser lifecycle corrections complete: direct Brave now includes Chromium's ordinary `--disable-background-mode` close-window flag. Owned termination is awaited and bounded: SIGTERM grace, SIGKILL fallback, then bounded final exit wait. Direct exit races the operation abort; timeout/abort cannot start verification or hang if child close never arrives, and actionable cleanup failures retain their cause.
- verified lifecycle corrections: red direct-launcher coverage failed before the exported bounded launcher existed; green focused tests (58 pass), configured full typecheck, source check, and diff check pass.
- Pi-confirmed direct-browser correction complete: the direct process is no longer the primary user-completion signal. `/chatgpt-web-login` starts owned Brave, opens a cancellable Pi confirmation, and on confirmation gracefully terminates only that child before headless verification. A natural zero exit remains the programmatic/no-UI fallback; false confirmation, timeout, abort, nonzero exit, and spawn failure write no readiness and never launch verification.
- verified Pi-confirmed correction: browser and command regressions cover confirmation success/cancellation, natural exit, child failure, timeout/abort, verification ordering, UI confirmation wiring, and losing-confirmation cleanup; focused tests (62 pass), configured full typecheck, source check, and diff check pass. Final correction review approved with no blocker or important issue.
- live direct-browser result: user completed ChatGPT login and the callback reached `https://chatgpt.com/api/auth/callback/openai`; Pi confirmation released the owned direct process. The immediate headless verification received HTTP 403 at exact origin/path `https://chatgpt.com/` with title `Just a moment...`; `/api/auth/session` returned 403 HTML and no account id. Readiness remains absent, no prompt was submitted, and headless completion plus `/async-compact-now` were not run. This is an external Cloudflare blocker under the no-bypass constraint.

## goal
make non-provider web compaction visually silent after one explicit login, and replace argument memorization for configuration commands with Pi-native selectors.

## assumptions
- `/compaction-mode` and `/async-compaction-backend` show selectors when invoked without arguments; explicit arguments remain supported for scripts and backward compatibility.
- action commands remain direct actions because they have no configuration choice.
- `/chatgpt-web-login` is the only operation allowed to open a visible browser.
- successful login uses a dedicated persistent Brave profile; normal web compaction launches that profile headlessly.
- Playwright automation is allowed only for this isolated profile. There is no CDP listening port, normal-profile access, provider fallback, or headed fallback.

## success criteria
- installation and ordinary compaction never open a visible browser.
- `/chatgpt-web-login` launches the dedicated Brave profile headed, waits for Pi confirmation (or a natural zero exit), releases only its owned process, verifies structured `/api/auth/session` headlessly, and writes an account-bound readiness marker.
- later web compaction requires readiness before launching Brave, launches the dedicated profile headlessly, verifies exact origin and the same account before composer access, submits once, extracts response-local rendered HTML, and closes its browser context.
- a missing/legacy marker, expired session, account mismatch, Cloudflare challenge, timeout, or cancellation submits nothing after the failure is known and never falls back to provider usage.
- the dedicated profile is serialized in-process; profile-lock failures are explicit.
- `/compaction-mode` and `/async-compaction-backend` provide cancellable `ctx.ui.select` menus when no argument is supplied; cancellation changes nothing.
- focused regressions, full tests, typecheck, source checks, release check, package dry-run, and one explicitly approved live headed-login/headless-completion smoke pass.

## plan
1. add failing tests for headed login versus headless completion, marker-version migration, pre-launch readiness, auth/account rejection, cleanup/abort behavior, and no provider fallback.
2. replace the AppleScript transport with a minimal `playwright-core` persistent-context adapter using the installed Brave executable and a dedicated private profile directory.
3. retain the existing generic web orchestration boundary, readiness/account binding, exact-origin validation, response-local HTML conversion, serialization, and failure translation; bump the marker version so the normal-profile authorization cannot authorize the new isolated profile.
4. add failing command tests for selector choice, cancellation, invalid scripted arguments, and non-UI behavior; implement Pi-native selectors without changing action-command semantics.
5. remove AppleScript-specific files, dependency state, tests, environment references, and documentation; document first-use login and headless failure behavior.
6. run focused tests during red/green loops, then one final repository gate and package dry-run.
7. after explicit approval for live browser use, reinstall, run one headed dedicated-profile login, one harmless headless completion, and one `/async-compact-now` integration smoke.

## risks
- ChatGPT or Cloudflare may reject headless Brave even after headed login. this must fail closed; no stealth or bypass behavior will be added.
- persistent Chromium profiles cannot be opened concurrently. another process using the dedicated profile will produce an actionable failure rather than profile copying or forced termination.
- a ChatGPT UI selector change can break completion while authentication remains valid; completion tests cover structure, but live behavior remains an upgrade smoke requirement.
