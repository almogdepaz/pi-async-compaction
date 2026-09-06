# audit findings remediation status

## status

- [x] reconcile the two audit reports into one scoped plan
- [x] phase 1 correctness and current compatibility
- [x] independent diff review (verified header-override and Cloudflare auth-boundary findings corrected; final re-review found no material production issue)
- [x] final verification
- [x] phase 2 lifecycle modernization (`0.84.3` minimum approved)
- [x] phase 2 simplification, documentation alignment, and final endpoint verification
- [ ] phase 3 evidence/adoption scope

## current assignment

- parent: phase 2 closed; no active `pi_compaction` child sessions
- worker sessions `033-auth-fix`, `033-final-review`, and `033-phase2-review` closed after terminal assignments
- initial implementer session: `42f35e2f-3f04-49cc-8211-b2be1384ca2d` (`033-implementation`)
- initial implementer task: `d2cfd210-0385-4049-bfcf-79d42e1e7e1b` — completed
- correction implementer task: `9b20abce-d93b-459e-bdb0-961d41f6c8b9` — timed out after focused correction verification
- prior reviewer task: `738e6f74-1ab4-4aca-bd68-bcf935ad07c2` — cancelled after its endpoint went offline
- first reviewer task: `71cd0bd6-762a-4ad8-a60e-39890e4cfd4f` — completed
- Cloudflare correction session: `79891043-bcd7-4643-8e2a-e147c98573ea` (`033-auth-fix`)
- Cloudflare correction task: `411ac2a5-0942-4d2b-8b85-7aa5220b346d` — completed and acknowledged
- final reviewer session: `e88a90ab-96ff-475c-a1eb-6422731e5d22` (`033-final-review`)
- final reviewer task: `4ab2d180-14e1-45c2-9a4d-c4a231910bb3` — completed and acknowledged
- phase 2 implementer reuses `033-auth-fix`
- phase 2 assignment 1 task: `b4b0ad52-627a-4372-a0a6-bd443878ff47` — retry-policy forwarding and compatibility-floor metadata completed and parent-verified
- phase 2 assignment 2 task: `13f2c790-d826-4b3f-9f4e-cb12847ceca2` — `agent_settled` apply and correlated compaction-failure terminal handling completed and parent-verified
- phase 2 assignment 3 task: `f50cc45a-dc58-4c23-b968-839b48a23d6a` — timed out after real retry/backoff-abort and `AgentSession` lifecycle integration regression verification
- phase 2 correction reviewer session: `835824b1-86c9-495f-a159-6426f4e24665` — verified project-trust retry leakage and mixed Pi compatibility installs
- phase 2 assignment 4 task: `34a4af2c-7f14-4ee6-9963-ace0e5de2749` — reviewer corrections completed, acknowledged, and parent-verified

## evidence

- final simplification pass: removed the one-caller ten-argument compaction wrapper and redundant second header merge; Pi's fully resolved `getApiKeyAndHeaders(model)` output now drives the request model directly, with one documented nullable-header cast retained at Pi's public type mismatch.
- project trust parity: both compaction and retry settings now pass `ctx.isProjectTrusted()` to Pi's `SettingsManager`; the focused regression was RED with untrusted project compaction values and GREEN after the correction.
- lifecycle test simplification: replaced the 130-line synthetic multi-run failure test with a focused correlated-handler test; real end-to-end behavior remains covered by the `AgentSession` integration.
- docs now describe native `agent_settled` application rather than deleted `agent_end` polling.
- compatibility matrix reproduction proved lock removal alone still selected `0.84.4` sibling transitives under Pi's `^0.84.3` ranges; CI now pins all seven installed Pi runtime-family packages to the matrix endpoint.
- FINAL GREEN on Pi `0.84.4`: full suite 87 pass, 1 intentional skip, 0 fail; explicit real-fixture parity 6 pass; typecheck, source check, audit, release consistency, package dry-run, and `git diff --check` passed.
- FINAL GREEN in a clean temporary Pi `0.84.3` install: all seven Pi runtime-family packages resolved to `0.84.3`; full suite 87 pass, 1 intentional skip, 0 fail; typecheck and explicit real-fixture parity 6 pass.

- GREEN phase 2 assignment 4: retry settings now pass `ctx.isProjectTrusted()` into `SettingsManager.create`, so an untrusted project's `.pi/settings.json` retry policy is ignored while isolated global retry settings remain effective.
- RED assignment 4 trust regression: isolated `test/utils.test.ts` received the project's enabled/9-retry/1ms policy instead of the global disabled/2-retry/300ms policy.
- compatibility matrix correction: remove `bun.lock` after the frozen baseline install and before each matrix-specific `bun add`, preventing Pi `0.84.3` jobs from retaining nested Pi `0.84.4` packages.
- focused assignment 4 verification: `bun test test/utils.test.ts` — 3 pass, 0 fail; `bun run typecheck` and `git diff --check` — clean.
- full suite intentionally not run per assignment scope; compaction settings, version/changelog, commit, push, and release remain untouched.
- GREEN phase 2 assignment 3: real Pi compaction retries one transient faux-provider failure exactly once (2 calls), abort during retry backoff prevents call 2, and every unique compatibility registration is unregistered after each test.
- GREEN real `AgentSession` integration: in-memory managers, a native faux provider, and an inline `DefaultResourceLoader` extension exercise production registration/adapter/job/apply behavior; ready work aborts the active call, persists one extension compaction, completes one `session_compact`, submits one auto-resume prompt, produces exactly one resumed provider call/assistant message, and emits `handed_off` once with no failure.
- correction: removed the mistaken `applied` assertion and reverted the out-of-scope public lifecycle-event expansion; the diagnostics API remains unchanged.
- focused assignment 3 verification: `bun test test/compaction-retry.integration.test.ts test/agent-session-compaction.integration.test.ts` — 3 pass, 0 fail; `bun run typecheck` and `git diff --check` — clean.
- full suite intentionally not run per assignment scope; no filesystem persistence, network access, commit, push, release, or version/changelog change was performed.
- GREEN phase 2 assignment 2: ready work applies directly at `agent_settled`, never registers `agent_end` polling, and remains blocked by pending messages; correlated extension compaction failure emits one apply failure, clears handoff/auto-resume state, ignores non-extension/uncorrelated events, and reports `compaction aborted` when Pi supplies no abort message.
- RED phase 2 lifecycle regressions: focused `test/index.test.ts` failed twice because `agent_settled` was unregistered; focused `test/core.test.ts` failed because `session_compact_failed` was unregistered.
- focused assignment 2 verification: `bun test test/index.test.ts test/core.test.ts test/job-failure.test.ts` — 21 pass, 0 fail; `bun run typecheck` and `git diff --check` — clean.
- full suite and actual `AgentSession` integration intentionally deferred per assignment scope.
- GREEN phase 2 assignment 1: effective `SettingsManager` retry policy is forwarded as Pi `compact()` argument 10 after `env`; `bun test test/job-start.test.ts` — 21 pass; `bun run typecheck` and `git diff --check` — clean.
- RED phase 2 retry regression: focused test failed as expected because Pi `compact()` argument 10 was `undefined`.
- compatibility floor raised with Bun: peer range, lockfile, CI minimum, and README now use Pi `0.84.3`; current development/CI remains Pi `0.84.4`; no `0.80.3` remains in active compatibility metadata.
- full suite intentionally not run for this assignment; lifecycle behavior, version/changelog, release, commit, and push remain untouched.
- FINAL GREEN on Pi `0.84.4`: full suite 82 pass, 1 intentional skip, 0 fail; explicit real-fixture parity 6 pass; typecheck, source check, audit, release consistency, package dry-run, and `git diff --check` passed.
- FINAL GREEN in a clean temporary Pi `0.80.3` install: typecheck; focused phase-1 tests 22 pass; explicit real-fixture parity 6 pass.
- final independent re-review found no material production issue; its low-severity staging note is satisfied by the present untracked `test/utils.test.ts`, which contains both `max` regressions and must be included with the eventual change.
- GREEN Cloudflare boundary correction: null header deletion markers reach `compact()` while matching request-model headers are removed case-insensitively; focused regression pattern — 2 pass; affected `test/job-start.test.ts` — 20 pass; `bun run typecheck` — clean.
- RED Cloudflare boundary regression: focused pattern — 2 expected failures because null deletion markers were dropped from the actual `compact()` header argument.
- GREEN reviewer correction: focused regression pattern — 2 pass; full affected `test/job-start.test.ts` — 20 pass; `bun run typecheck` — clean.
- root cause confirmed: the initial correction cleaned matching `requestModel.headers` but normalized nullable tombstones out of compact options; the compatibility boundary now passes raw `ProviderHeaders` to Pi while retaining the case-insensitive request-model cleanup.
- RED reviewer regression: focused `test/job-start.test.ts` run — 2 expected failures proving deleted/overridden auth headers remain in `requestModel.headers` across casing variants.
- GREEN: `bun test test/utils.test.ts` — 2 pass; `max` reconstruction and marker acceptance verified.
- GREEN: `bun test test/job-start.test.ts` — 18 pass; resolved auth contract and lifecycle regressions verified.
- GREEN on Pi `0.80.3`: `bun run typecheck`; focused correctness tests 20 pass; explicit deterministic parity 6 pass.
- GREEN on Pi `0.84.4`: `bun run typecheck`; focused correctness tests 20 pass; explicit deterministic parity 6 pass.
- metadata check: no scoped `0.84.1` references remain; dev dependencies, lockfile, CI matrix, and README use `0.84.4`.
- CI matrix now runs explicit deterministic parity at both `0.80.3` and `0.84.4`.
- GREEN: `bun run typecheck` — clean after correctness changes.
- RED: `bun test test/utils.test.ts` — 2 expected failures (`max` reconstructed as `off`; marker rejected).
- RED: focused `test/job-start.test.ts` auth run — 3 expected failures (base URL dropped, header-only rejected, missing-material diagnostic mismatch).
- source history checked for `src/utils.ts` and `src/job.ts`; no previously reverted fix exists.
- installed Pi's canonical request-auth path accepts API key or headers and overlays resolved `baseUrl` on the request model.
- current `compact()` accepts `apiKey: string | undefined`.

## constraints

- no commit/push/release without explicit approval
- preserve unrelated untracked files
- test-first, focused tests during implementation; full suite once at final gate
