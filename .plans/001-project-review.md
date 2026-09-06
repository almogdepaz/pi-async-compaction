# full project review

reviewed: 2026-08-08  
target: `main` at `43234dc`  
scope: architecture, correctness, security, lifecycle/concurrency, compatibility, performance, maintainability, tests, packaging, documentation, and developer experience

## executive verdict

this is a compact, well-documented extension with a sound core idea and unusually good Pi-compaction parity coverage. the built-in single-adapter path is generally careful about snapshot validity, tail continuity, cancellation, and synchronous fallback.

it is not release-ready at current `main`. two issues dominate:

1. `main` contains unreleased behavior while still claiming the already-published `0.1.6` version.
2. the advertised experimental multi-package adapter API does not isolate adapter identity, state attribution, status, or job ids.

there is also a real apply idempotence race, current Pi compatibility has fallen behind, and the repo lacks CI/release gates. no concrete direct security vulnerability was found in extension code.

## scorecard

| area | score | assessment |
| --- | ---: | --- |
| architecture | 8/10 | small modules, explicit lifecycle, clear compatibility boundary |
| built-in correctness | 7/10 | strong validation/fallback, but apply is not idempotent |
| adapter API correctness | 4/10 | identity fields exist but are not used for isolation or attribution |
| security | 8/10 | narrow trust surface; no direct vulnerability found |
| tests | 7/10 | 93% line coverage and real parity sentinel; important concurrency/branch gaps remain |
| maintainability | 7/10 | mostly lean; lifecycle complexity is concentrated in `src/job.ts` |
| packaging/release | 4/10 | package is lean, but version/tag/changelog state is inconsistent and CI is absent |
| documentation | 7/10 | extensive and readable, but git install/version and release-state claims drift |
| current Pi compatibility | 3/10 | declared `0.80.x` works; latest `0.84.1` fails typecheck |
| performance evidence | 5/10 | architecture plausibly reduces waits, but there are no benchmarks, hit-rate metrics, or cost data |

## strengths

- **safe fallback contract:** `session_before_compact` returns a ready result only after validating custom instructions, session/model/thinking/settings identity, branch continuity, first-kept identity, and post-apply size (`src/core.ts:127-150`, `src/validation.ts:26-81`). invalid work falls back to Pi.
- **good async correlation:** pending callbacks check both lifecycle state and `jobId` before mutating state (`src/job.ts:204-209`, `src/job.ts:289-313`). timeout clears status even when a worker never settles.
- **Pi parity is treated as a contract:** production uses exported Pi generation primitives while the tests compare the local preparation mirror against Pi's private implementation (`src/preparation.ts`, `test/parity-fixtures.ts`, `test/pi-parity.test.ts`). the opt-in realistic fixture passed.
- **tail continuity is explicitly tested:** the suite verifies `summary(snapshot prefix) + appended raw tail` ordering (`test/index.test.ts:274-342`).
- **strict and lean package:** strict typecheck, syntax check, 19 packed files, 116.65 KB unpacked, and no runtime dependency bundle.
- **clear documentation:** README, design documentation, adapter migration guide, changelog, package metadata, and issue templates cover the intended workflow well.
- **narrow security surface:** extension production code does not execute subprocesses or perform direct filesystem writes. external access is delegated to Pi's model registry and compaction implementation.

## prioritized findings

### high — release metadata describes code that cannot be published as declared

**evidence**

- `package.json:3` still declares `0.1.6`; npm latest is also `0.1.6`.
- `v0.1.6` points to `c2e4fad`, while current `main` adds `b7cc105` and `43234dc`.
- those commits add active-turn force compaction and auto-resume, and current README/design docs describe that behavior.
- `CHANGELOG.md` ends at `0.1.6` and does not describe either post-tag change.
- `README.md:45` still tells git users to install `v0.1.4`, omitting later adapter and reliability changes.

**impact**

`main` and npm have different behavior under the same version. npm will reject republishing the existing version, bug reports cannot reliably identify code, and the documented git command installs an older release.

**improvement**

release the current behavior under a new version after the correctness findings below are resolved. update changelog, git install example, tested Pi version, tag, package preview, and release notes from one release checklist. add a CI gate that fails when `HEAD` differs from the version tag without an explicit unreleased changelog section.

### high — adapter instances are not isolated or correctly attributed

**evidence**

- adapters require `id` and `label` (`src/adapter.ts:34-35`), but production never reads either field.
- all instances use the same status key (`src/core.ts:44`, `src/job.ts:97`) and generate identical ids such as `async-prefix-compaction-1` (`src/runtime-state.ts:18-20`).
- stored markers always use the global built-in prompt version instead of `snapshot.promptVersion` (`src/job.ts:176-187`).
- marker parsing accepts only the global version and contains no adapter owner (`src/utils.ts:64-88`).
- every registered core instance reacts to every accepted marked compaction and emits a notification (`src/core.ts:152-163`), even if it did not hand off that result.
- an ad hoc two-registration probe produced two notifications for one marked compaction.

**impact**

installing the built-in extension alongside another package using `pi-async-compaction/core`, or registering multiple adapters, causes status collisions and duplicate notifications. matching per-instance job ids can also misattribute handoff/auto-resume state and send an unrelated `continue` message. this directly contradicts the package-author API's purpose.

**improvement**

make adapter ownership part of the data model: namespace status and job ids by adapter id, persist a typed `adapterId` plus the adapter's prompt version in the marker, and require owner/version/job correlation before notification or auto-resume. reject duplicate adapter ids during registration. `label` should drive user-visible status text or be removed from the contract.

### medium — ready application is not idempotent

**evidence**

- `applyReadyCompaction` validates a `ready` job, calls the fire-and-forget `ctx.compact`, and leaves state as `ready` until `session_before_compact` later hands it off (`src/job.ts:117-141`, `src/core.ts:127-150`).
- application can be requested from background completion, agent-end retries, and manual ready reuse.
- Pi's extension context implements `compact()` as an async detached operation, so the state transition is not synchronous with the trigger (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1829-1839`).
- an ad hoc probe calling `applyReadyCompaction` twice while ready returned `true` twice and triggered compaction twice.

**impact**

closely timed completion/retry/manual paths can start concurrent compactions for the same ready result. consequences include duplicate model work, duplicate compaction entries, fallback races, or misleading apply errors.

**improvement**

atomically claim the job before calling Pi. model `applying` explicitly, or add a correlated apply-in-flight state that blocks all other triggers and is cleared only by handoff, apply failure, cancellation, or verified completion. add a regression using a deferred `ctx.compact` boundary.

### medium — current Pi releases are unsupported and fail the source contract

**evidence**

- peers are capped at `>=0.80.3 <0.81.0` (`package.json:71-82`); README says testing is against `0.80.3` (`README.md:187`).
- `bun outdated` reports Pi `0.80.10` as the compatible update and `0.84.1` as latest.
- a temporary clean run against `0.80.10` passed strict typecheck, all 54 default tests, and real parity.
- a temporary clean run against `0.84.1` failed strict typecheck at `src/job.ts:47`: Pi's `ProviderHeaders` now permits `null`, while `compact` still expects `Record<string, string> | undefined`.

**impact**

new Pi users on the current release cannot satisfy the package's peer range. the package's discoverability work is undermined if the likely install target is four minor lines behind.

**improvement**

first update the lock to `0.80.10`. then add a compatibility branch for current Pi, normalize the changed headers at the typed boundary, rerun preparation parity, and widen peers only after a clean install/load/typecheck/test matrix. automate tests for the minimum supported, latest compatible patch, and current Pi.

### medium — forced auto-resume does not re-check queued user work

**evidence**

- force apply checks `hasPendingMessages()` before aborting (`src/job.ts:24-31`).
- after compaction persists, `session_compact` schedules `pi.sendUserMessage("continue")` without checking whether user input arrived during compaction (`src/core.ts:157-163`).
- the test covers the happy path but not input arriving between abort and persistence (`test/index.test.ts:187-237`).

**impact**

if a user queues steering/follow-up input while compaction is running, the synthetic `continue` can become redundant or alter message ordering.

**improvement**

re-check pending messages at the deferred callback and define the intended ordering contract. preferably use a Pi retry/resume primitive tied to the aborted turn if upstream exposes one, rather than encoding resume as a generic user message.

### medium — no CI or release automation protects a public package

**evidence**

there are no tracked `.github/workflows`, `tsconfig`, formatter/linter config, dependency update config, or release checks. all verification exists only as package scripts and documentation.

**impact**

strict checks and parity tests are good but optional. the current version/tag/changelog drift is exactly the class of failure a release workflow should block.

**improvement**

add minimal CI for install, `bun test`, strict typecheck, syntax check, pack dry-run, real parity, audit reporting, and compatibility matrix. keep it boring; no build system is needed.

### medium — dependency audit is not clean

**evidence**

`bun audit` reports 8 transitive advisories: 3 high and 5 moderate in `brace-expansion`, `protobufjs`, and `undici`. the extension does not directly call the vulnerable parsing/cache surfaces, and these dependencies arrive through the Pi development/peer graph.

**impact**

this is primarily development and upstream supply-chain exposure, not a verified direct extension exploit. it still prevents a clean security gate and leaves contributors testing with known-vulnerable packages.

**improvement**

refresh compatible transitive locks, document advisories that require an upstream Pi release, and make audit output a reviewed CI artifact rather than silently accepting it.

### low — tests miss several critical branch and concurrency contracts

**evidence**

coverage is strong at 93.47% functions and 93.01% lines, but branch coverage is not reported. current tests do not directly assert all documented invalidation reasons, duplicate apply suppression, adapter owner isolation, prompt-version preservation, or user input arriving before auto-resume. configuration tests only assert the timeout default (`test/configuration.test.ts`).

**improvement**

add behavior-level regressions for the verified findings first, then table-drive session/model/thinking/settings/first-kept/tool-result/order invalidations and environment parsing boundaries. avoid chasing line coverage for its own sake.

### low — generated EDC guidance is stale

**evidence**

`edc-context/manifest.json` records source commit `527d203`; current `HEAD` is `43234dc`. the generated module context predates the force-apply/auto-resume lifecycle and still reports no known issues.

**impact**

future agents are routed through architecture guidance that omits the newest, highest-risk state transitions.

**improvement**

regenerate EDC context after correctness/release fixes and make source-commit freshness visible in CI.

### low — performance and cost claims are not measured

background preparation moves latency but does not remove the model call. stale, invalidated, timed-out, or synchronously superseded work can add a second paid compaction call. the project exports no hit-rate, saved-wait, wasted-call, or timing metrics (`ASYNC_COMPACTION_DESIGN.md:224`) and has no benchmark.

**improvement**

add opt-in counters/timing hooks or debug logging and publish a simple benchmark: ready-hit rate, median foreground wait saved, background duration, invalidation reasons, and estimated wasted compaction calls. document the potential extra model cost plainly.

## inherent tradeoffs / cons

- pending and ready state is in-memory only; reload/restart loses work.
- one job per registration keeps reasoning simple but limits throughput.
- local preparation mirrors a Pi private function, creating deliberate compatibility debt.
- early background summaries can be wasted after model/settings/tree changes.
- active-turn force compaction is more responsive but more intrusive than idle-only application.
- generic `continue` is an approximation of resuming the exact aborted operation.

## verification evidence

| command/probe | result |
| --- | --- |
| `bun test` | 54 pass, 1 opt-in skip, 0 fail |
| `bun run typecheck` | pass |
| `bun run check` | pass |
| `bun pm pack --dry-run` | pass; 19 files, 116.65 KB unpacked |
| `PI_RUN_REAL_COMPACTION_PARITY=1 bun test test/pi-parity.test.ts` | 6 pass, 0 fail |
| `bun test --coverage` | 93.47% functions, 93.01% lines |
| `bun audit` | 8 advisories: 3 high, 5 moderate |
| temporary Pi `0.80.10` matrix | typecheck, default tests, real parity pass |
| temporary Pi `0.84.1` matrix | typecheck fails at provider-header contract |
| duplicate apply probe | 2 calls, 2 triggers, state remains `ready` |
| two-adapter attribution probe | 2 handlers, 2 notifications for one compaction |
| fixture integrity | 274 valid JSONL records; real parity consumes it successfully |

## recommended sequence

1. fix adapter ownership/isolation and duplicate apply at the state-model level, with regression tests.
2. close the queued-input auto-resume race or explicitly narrow/document the contract.
3. update to Pi `0.80.10`, then implement and test current-Pi compatibility.
4. add minimal CI and release/version consistency gates.
5. release a new version with changelog, current git-install tag, and refreshed EDC context.
6. clean dependency advisories and add opt-in performance/cost evidence.

## limitations

- no live interactive Pi session was driven through an actual paid model call; deterministic Pi compaction parity was used instead.
- dependency internals were not security-audited; `bun audit` and exposed contracts were assessed.
- no production code, tests, package metadata, or existing documentation was modified.
