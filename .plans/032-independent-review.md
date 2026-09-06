# independent review: performance, upstream api, compatibility, and adoption

## scope and baseline

read-only audit of commit `f59dd49` (`pi-async-compaction` 0.1.7) against installed Pi 0.84.3. production code, tests, docs, package metadata, CI, the live pi.dev package page, npm/GitHub public metadata, and Pi's installed declarations/runtime were inspected.

`$PI` below means `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`.

fresh local evidence:

- `bun test`: 75 pass, 1 intentionally skipped provider-independent real-fixture parity test, 0 fail, 310 ms.
- ad hoc CPU benchmark, five rounds after warm-up, 273-entry/761,930-byte fixture:
  - `SettingsManager.create(...).getCompactionSettings()`: median 0.0867 ms/call over 1,000 calls/round.
  - `prepareAsyncCompaction()`: median 0.1138 ms/call over 200 calls/round.
- runtime reproduction of a persisted `thinking_level_change: "max"`: `getThinkingLevel()` returned `"off"`; an otherwise valid async marker with `thinkingLevel: "max"` was rejected.
- public snapshot at review time: npm package 0.1.7, Pi npm latest 0.84.4, 24 daily / 66 weekly / 393 monthly package downloads; live pi.dev page returned 200; GitHub reported 0 stars, 0 forks, 0 watchers, and no homepage.

## verdict

the state machine is defensive and the test surface is broad. local CPU overhead is already negligible relative to the provider request, so optimizing array copies or settings reads would be yak shaving.

promotion should wait for two compatibility defects: valid Pi `max` thinking is silently downgraded, and background model calls do not preserve Pi's full resolved-request contract. after those, the highest-value work is adopting Pi's retry/settlement lifecycle and measuring actual provider cost, invalidation, handoff, and user-visible wait avoided. current marketing describes the mechanism clearly but cannot yet substantiate the outcome.

## findings

### f1 — valid `max` thinking is silently converted to `off`

- severity: **high** for affected models
- confidence: **high**
- priority: **p0**

**evidence**

- `src/utils.ts:96-103` reconstructs thinking from the session, but its allowlist ends at `xhigh`.
- the same predicate gates persisted async markers at `src/utils.ts:65-89`, so a marker carrying `max` is also rejected.
- Pi added `max` in 0.80.6, inside this package's declared `>=0.80.3 <0.85.0` range (`$PI/CHANGELOG.md:656-665`); installed agent-core declares it in `$PI/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:260`.
- direct reproduction returned `{ "resolved": "off", "markerAccepted": false }`.

**impact**

background summaries on supported models run without the user's selected reasoning level. snapshot validation compares the same incorrectly reconstructed value, so it does not detect the downgrade. this is a silent quality/behavior mismatch, not merely stale typing.

**recommendation**

add `max` to the accepted domain and add regression tests for both session reconstruction and marker parsing. longer term, prefer Pi's current `ctx.thinkingLevel` as the live source when the compatibility floor permits it, while retaining persisted-state validation where needed.

### f2 — background requests drop resolved endpoints and reject valid header-only auth

- severity: **high**
- confidence: **high**
- priority: **p0**

**evidence**

- `src/job.ts:53-61` resolves request auth, requires `auth.apiKey`, and invokes `compact()` with the original model.
- Pi's public resolved-auth result includes optional `apiKey`, `headers`, `baseUrl`, and `env` (`$PI/dist/core/model-registry.d.ts:5-14`). Pi can legitimately return `{ ok: true, headers }` without an API key (`$PI/dist/core/model-registry.js:30-46`).
- Pi's own request path accepts `apiKey || headers` and overlays `auth.baseUrl` onto the request model (`$PI/dist/core/agent-session.js:163-182`).
- Pi explicitly fixed extension/custom-compaction calls that dropped credential-resolved endpoints, including Copilot Business/Enterprise (`$PI/CHANGELOG.md:330-331`).
- tests cover `env` and nullable-header normalization but not `baseUrl` or header-only auth (`test/job-start.test.ts:19-90`).

**impact**

Copilot Business/Enterprise and other credential-selected endpoints can be sent to the model catalog's default URL instead of the resolved URL. ambient/header-only providers are rejected before a request. the extension also calls exported `compact()` without Pi's session stream function, so native/custom provider transport and per-request provider hooks may not match normal session requests.

**recommendation**

immediately align with Pi's required-request behavior: allow headers-only auth, normalize headers, and call `compact()` with a request model containing resolved `baseUrl`. add regression tests for both cases. separately request or adopt a public generation-only compaction API that runs through the session's model runtime; `modelRegistry.complete()` is public, but it is not a drop-in `StreamFn`, so do not invent a brittle stream wrapper without an integration test.

### f3 — background compaction opts out of Pi's transient retry policy

- severity: **medium**
- confidence: **high**
- priority: **p1**

**evidence**

- `src/job.ts:45-61` supplies only the first nine `compact()` arguments.
- Pi 0.84.3 accepts retry policy/callbacks in positions 10/11 (`$PI/dist/core/compaction/compaction.d.ts:94-100,130-137`). Pi's own caller passes `settingsManager.getRetrySettings()` and retry callbacks (`$PI/dist/core/agent-session.js:1383`).
- resilient compaction retries landed in Pi 0.81.1 (`$PI/CHANGELOG.md:482-495`), later than this package's minimum.
- `test/job-failure.test.ts:60-79` verifies terminal background failure only; there is no transient-failure/retry coverage.

**impact**

one transient stream/provider failure discards the background attempt. the next eligible turn can start another full job, increasing latency and potentially repeating billable work, while normal Pi compaction would retry within its configured budget.

**recommendation**

choose a compatibility policy explicitly: raise the minimum to at least 0.81.1 and forward the retry policy, or isolate a tested version adapter while retaining 0.80.3. test one retryable failure followed by success, deterministic failure without retry, and abort during backoff.

### f4 — bounded `agent_end` polling duplicates a now-exact Pi lifecycle event

- severity: **medium**
- confidence: **high**
- priority: **p1**

**evidence**

- `src/core.ts:102-121` polls every 25 ms up to 40 times; `src/core.ts:139-141` starts polling from `agent_end`.
- constants encode an approximately one-second ceiling (`src/constants.ts:7-8`).
- Pi's `agent_settled` fires only after automatic retry, compaction, and queued continuation have all stopped (`$PI/dist/core/extensions/types.d.ts:554-562`). it was added in 0.80.4 (`$PI/CHANGELOG.md:678-695`), one patch above this package's minimum.
- tests faithfully mock timer retries (`test/index.test.ts:180-225`) but do not exercise a real settlement taking over one second.

**impact**

this creates up to 41 timers per ended run and, more importantly, a bounded race: a ready result can remain unapplied after a long retry/settlement and wait for some later event. the timer cost itself is trivial.

**recommendation**

move safe idle apply to `agent_settled` and retain the pending-message and final validation guards. either raise the minimum to 0.80.4+ or keep a small, explicit legacy path; do not retain polling on versions that expose the exact event.

### f5 — passive handoff failures have no terminal cleanup event

- severity: **medium-low**
- confidence: **high**
- priority: **p2**

**evidence**

- handoff moves the job to `idle`, clears `ready`, and stores `lastHandedOff` (`src/core.ts:155-189`).
- success clears correlation and optional auto-resume state (`src/core.ts:192-210`).
- extension-triggered `ctx.compact({ onError })` failures are handled (`src/job.ts:131-156,183-196`), but a ready result may also be consumed by manual/threshold/overflow compaction (`README.md:94-97`) where this extension owns no callback.
- no `session_compact_failed` handler exists. Pi 0.84.3 now emits structured failure/abort metadata including `reason`, `willRetry`, and `fromExtension` (`$PI/dist/core/extensions/types.d.ts:463-475`; `$PI/CHANGELOG.md:21-23`).

**impact**

a failed passive handoff leaves correlation/lifecycle state unterminated and produces no package lifecycle failure diagnostic. extension-triggered failures are already covered, so this is not a general stuck-state bug.

**recommendation**

when the minimum supports it, handle `session_compact_failed`, correlate only extension-provided content, clear handoff/auto-resume state, and emit one terminal failure. test passive manual failure, abort, and overflow `willRetry` separately.

### f6 — the meaningful performance and wasted-work outcomes are unmeasured

- severity: **medium**
- confidence: **high**
- priority: **p1**

**evidence**

- there is no benchmark/profiling script in `package.json:16-20` or CI (`.github/workflows/verify.yml:19-26`).
- lifecycle events expose duration and only categorical `possible|confirmed` wasted work (`src/diagnostics.ts:1-29`); README correctly warns that this is not billing (`README.md:171-186`).
- local CPU measurements above are ~0.09 ms for settings load and ~0.11 ms for preparation on the large fixture: not material beside an LLM call.
- README claims “less waiting” and that ready summaries “usually” apply at idle (`README.md:15-23,25-32,84-97`) without latency, success-rate, invalidation-rate, or cost evidence.

**impact**

there is no answer to the actual product questions: how often early work is used, how much synchronous wait is avoided, what it costs, which invalidations dominate, or whether the 0.8 default is a good tradeoff. test coverage cannot answer these.

**recommendation**

build a privacy-preserving benchmark harness around recorded structural fixtures and lifecycle events. report p50/p95 start-to-ready, ready-to-handoff, handoff success, invalidation by reason, fallback rate, provider usage/cost for discarded ready results, and synchronous wait avoided versus the same model/fixture with the extension disabled. keep prompt/summary text out of metrics and label provider/network results as environment-specific.

### f7 — preparation parity is strong but tied to a private test import and incomplete matrix execution

- severity: **medium** compatibility risk
- confidence: **high**
- priority: **p2**

**evidence**

- production locally mirrors entry projection, token estimation, file-operation inheritance, and preparation (`src/preparation.ts:15-128`; `src/utils.ts:109-140`). the design acknowledges this (`ASYNC_COMPACTION_DESIGN.md:217-224`).
- current Pi root exports `compact`, `findCutPoint`, `estimateTokens`, and token helpers, but not `prepareCompaction` or `estimateContextTokens` (`$PI/dist/index.d.ts:1-8`). there is no public replacement today.
- the parity sentinel deep-imports `node_modules/.../dist/core/compaction/compaction.js` and explicitly labels it private (`test/parity-fixtures.ts:4-10`).
- shape coverage is useful but narrow (`test/pi-parity.test.ts:22-74`). deterministic long-fixture result parity is env-gated (`test/pi-parity.test.ts:20,76-97`). current CI enables it only in the pinned-current job (`.github/workflows/verify.yml:19-24`); the 0.80.3/0.84.1 matrix runs plain `bun test`, so skips it (`.github/workflows/verify.yml:28-44`).

**impact**

upstream entry projection/token semantics can drift while mocked lifecycle tests remain green. private-path breakage will fail loudly, which is preferable to silent drift, but the supported-version endpoints do not both exercise the strongest parity sentinel.

**recommendation**

keep the production mirror narrow until Pi publicly exports preparation. run explicit deterministic parity at both minimum and current supported Pi versions; add cases for `max`, custom messages, empty branch summaries, malformed historical content, metadata-adjacent cut points, and prior extension compactions. pin “current” to the actual supported maximum or add scheduled latest-within-range CI; package/dev/CI/docs currently stop at 0.84.1 (`package.json:79-81`, `.github/workflows/verify.yml:32`, `README.md:204`) while installed Pi is 0.84.3 and npm latest is 0.84.4.

### f8 — local CPU cleanup is not a release priority

- severity: **informational**
- confidence: **high**
- priority: **defer**

**evidence**

- settings are synchronously reconstructed on each eligibility/validation path (`src/utils.ts:92-94`; `src/job.ts:336-357`).
- preparation makes several full-array copies/scans (`src/preparation.ts:69,79,115,124`) and thinking reconstruction adds another context build (`src/utils.ts:96-98`).
- measured medians remain below 0.12 ms/call on the 273-entry fixture.

**recommendation**

do not cache settings or add indexing abstractions absent profile evidence. adopting `ctx.thinkingLevel` can remove one scan while fixing correctness, but complexity solely to save these sub-millisecond costs is unjustified.

## newer Pi api opportunity matrix

| capability | current status | recommendation |
| --- | --- | --- |
| `agent_settled` | available since 0.80.4; unused | replace bounded `agent_end` polling |
| `session_compact_failed` | available in 0.84.3; unused | correlate passive handoff failures when version policy permits |
| compaction `reason` / `willRetry` | available throughout declared range (0.79.10+); ignored | use in failure diagnostics/tests; current handoff behavior need not branch without a concrete semantic need |
| compaction retry policy | available since 0.81.1; omitted | forward Pi settings after choosing minimum/version adapter |
| resolved `baseUrl` / headers / `env` | available; only headers/env partly forwarded | fix endpoint and header-only parity now |
| optional routing session ID | available in 0.84.3; omitted | low priority; measure provider-routing benefit before coupling jobs to a session ID |
| public `prepareCompaction` | not exported from package root | keep mirror + parity sentinel; request upstream public API rather than production deep import |
| `ctx.thinkingLevel` | available in current Pi, absent at 0.80.3 | use after compatibility decision; add `max` immediately regardless |

## test and benchmark gaps, prioritized

1. **regressions before code changes:** `max` reconstruction/marker acceptance; resolved `baseUrl`; headers-only auth.
2. **lifecycle modernization:** real `agent_settled` ordering after retries/queued continuation; settlement beyond one second; `session_compact_failed` after passive handoff.
3. **provider behavior:** transient summary failure then retry success; abort during retry delay; native/custom provider path; request-hook/header preservation.
4. **integration:** actual `AgentSession` abort → extension handoff → persisted compaction → exactly one resume. current injected-context tests are strong state-machine units but cannot prove session ordering.
5. **compatibility:** explicit deterministic parity at minimum and current Pi, not just typecheck/mocked tests.
6. **outcomes:** paired enabled/disabled provider runs with latency, handoff, invalidation, fallback, token, and cost distributions. publish raw method and caveats.

## README and gallery adoption review

### what already works

- the name, one-line install, Pi badge, concise mechanism, and end-user benefits are above the fold (`README.md:1-23`).
- the normal-vs-async table explains the category clearly (`README.md:25-32`).
- package metadata supplies a gallery image (`package.json:67-72`), and the pi.dev page is live.
- configuration, limitations, lifecycle diagnostics, and author API are documented rather than hidden (`README.md:105-129,161-186`; `ASYNC_COMPACTION_DESIGN.md:217-225`).

### conversion gaps

- the “demo” is a static image plus status text (`README.md:60-82`); it cannot show the temporal benefit the package sells. the roadmap already admits the missing terminal GIF (`README.md:188-192`).
- there is no quantified proof for “less waiting,” no compatibility badge/table, and no visible failure/cost tradeoff near the install decision.
- `README.md:155-159` reads like keyword stuffing (“What should agents search for?”). package keywords already cover discovery (`package.json:22-40`); this section costs credibility without adding product evidence.
- npm downloads demonstrate discovery, not active use. zero GitHub stars/forks/watchers and no public downstream evidence mean testimonials or adoption claims would be fabricated.

### adoption recommendations

1. fix f1/f2 before broader promotion; publish the fixes as a concrete release.
2. replace or supplement the static image with a 20–30 second real terminal recording showing background start, continued work, ready, handoff, and the avoided synchronous pause.
3. publish the reproducible paired benchmark and lead with measured p50/p95 plus cost/invalidation caveats, not generic “faster” language.
4. tighten the first screen to problem → measured payoff → demo → install; move the author-framework pitch lower.
5. replace the search-phrase FAQ with compatibility, cost, and privacy answers. add one restrained feedback/star CTA after the evidence, not above it.
6. set the GitHub homepage to the pi.dev package page or documentation landing page, then announce the evidence-backed release in Pi-specific channels. do not treat download counts as user telemetry.

## recommended sequence

### release 1 — correctness without forcing a new floor

1. fix `max` thinking.
2. preserve resolved `baseUrl`, allow headers-only auth, and test request parity.
3. update current-version CI/docs from 0.84.1 to npm-latest 0.84.4 and run explicit parity at both endpoints.

### release 2 — explicit compatibility/lifecycle decision

1. choose a newer minimum or a small, isolated version adapter.
2. adopt retry policy and `agent_settled`.
3. add `session_compact_failed` handling when supported.
4. add actual `AgentSession` lifecycle integration coverage.

### evidence and adoption pass

1. add the paired provider benchmark and privacy-safe wasted-work metrics.
2. publish the real terminal recording and measured README claim.
3. then promote through Pi-specific package/community channels and solicit explicit user feedback.

## final assessment

no evidence supports a CPU-performance rewrite. the extension's leverage and risk are both at the provider/lifecycle boundary: correct thinking/auth/transport, retry behavior, safe settlement, and whether speculative summaries are actually consumed. fix the two high-confidence compatibility defects, modernize against an explicit Pi floor, and measure outcomes before scaling adoption claims.
