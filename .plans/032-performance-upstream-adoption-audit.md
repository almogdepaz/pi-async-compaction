# performance, upstream api, and adoption audit

## verdict

`pi-async-compaction` is substantially correct and unusually well tested for a young extension. its core promise is real locally: 1,087 structured async-compaction entries exist across 341 local pi sessions, representing 97.3% of the 1,117 local compaction entries checked. that proves this installation uses the extension; it does not prove external adoption.

no catastrophic correctness defect was found. two current-api gaps should be fixed before promotion: max-thinking sessions are silently summarized with thinking disabled, and background summaries omit pi's retry policy. the apply lifecycle should also move from a one-second `agent_end` polling window to pi's exact `agent_settled` event.

## findings

### p1 — support pi's `max` thinking level

severity: high for affected sessions; confidence: high

- pi added `"max"` in 0.80.6, inside the declared peer range.
- `src/utils.ts:101-103` accepts only `off|minimal|low|medium|high|xhigh`.
- `src/utils.ts:96-99` therefore maps a valid `max` session to `off`.
- the same validator rejects persisted markers whose thinking level is `max` at `src/utils.ts:65-89`.
- direct reproduction returned `{ resolved: "off" }` and `markerAccepted: false`.

impact: background summaries for max-thinking sessions silently use no reasoning. validation also compares the incorrect `off` snapshot to the same incorrect reconstruction, so it does not catch the downgrade.

recommendation: add `max` to the validated set and regression-test both session reconstruction and marker parsing.

### p1 — use pi's summarization retry policy

severity: medium; confidence: high

- `src/job.ts:45-62` invokes exported `compact()` without retry policy or callbacks.
- since pi 0.84.1, `compact()` accepts retry configuration. pi 0.84.4's built-in caller passes `settingsManager.getRetrySettings()` and retry lifecycle callbacks.
- upstream `retryAssistantCall()` explicitly performs no retries when policy is undefined.

impact: transient provider/transport failures fail background work immediately, while normal pi compaction can retry up to the configured budget. synchronous fallback protects correctness, but avoidable failures reduce the extension's latency benefit.

recommendation: decide compatibility policy explicitly. either feature-adapt the newer call while preserving 0.80.x, or raise the minimum supported pi version and pass the configured retry policy. callbacks are optional; policy parity matters first.

### p1 — replace `agent_end` polling with `agent_settled`

severity: medium; confidence: high

- `src/core.ts:102-121` polls every 25 ms for at most 40 retries, a roughly one-second window.
- `src/core.ts:139-141` starts this from `agent_end`.
- pi documents `agent_end` as a low-level run boundary; retries, automatic compaction, and queued continuation can still run afterward.
- pi's `agent_settled` event exists since 0.80.4 and fires only after no automatic retry, compaction, or queued continuation will run.

impact: unnecessary timers and a bounded race. a ready job can remain unapplied if settlement takes over one second, despite pi later reaching the exact safe boundary.

recommendation: raise the lower peer bound from 0.80.3 to at least 0.80.4 and apply on `agent_settled`; remove the polling constants and tests. retain pending-message and validation guards.

### p2 — refresh compatibility to current pi 0.84.4

severity: medium; confidence: high

- npm latest is 0.84.4.
- `package.json:79-81`, `.github/workflows/verify.yml:32`, and `README.md:204` stop at 0.84.1.
- fresh checks passed on both endpoints:
  - pi 0.80.3: typecheck clean; 75 pass, 1 intentional skip.
  - pi 0.84.4: typecheck clean; 75 pass, 1 intentional skip.
  - pi 0.84.4 explicit real parity: 6 pass, including deterministic compaction of the 273-entry real fixture.
- pi 0.84.4 added important compaction fixes: reject truncated summaries, prevent tool calls during summarization, and compact before a post-tool model request. this package inherits those generation fixes because it calls pi's runtime `compact()`.

recommendation: pin development/current ci to 0.84.4 while retaining the chosen minimum job. add a scheduled compatibility run or renovate-style update so “current” cannot silently age.

### p2 — no public preparation api replaces the local mirror yet

severity: informational; confidence: high

- pi's root export exposes `compact`, `findCutPoint`, and related primitives, but not `prepareCompaction` through 0.84.4 or current `origin/main`.
- upstream issue #8596 requesting read-only preparation was closed without action.
- the existing local preparation mirror remains justified.
- current parity evidence is strong: shape sentinels plus deterministic real-fixture parity pass against 0.84.4.

recommendation: keep the mirror narrow and keep current-version parity mandatory in ci. do not deep-import pi internals.

### p2 — the safe queued-message apply api is not upstream

severity: informational; confidence: high

- local upstream branch `deferred-extension-compaction` contains a draft `requestCompactionBeforeNextTurn` implementation.
- `origin/main`, installed 0.84.3, and released 0.84.4 do not expose it.
- issue #6553 was auto-closed with `no-action`; no maintainer approval or submitted upstream pr was found.
- prior real probe evidence correctly shows direct `ctx.compact()` at `turn_end` can abort/disconnect queued work and prevent clean settlement.

recommendation: do not use direct turn-end apply. retain queued-message guards. keep the draft ready, but do not claim the api exists or repeatedly post upstream without maintainer interest.

### p2 — performance overhead is not the problem; missing outcome benchmarks are

severity: medium; confidence: high

measured locally:

- `SettingsManager.create(...).getCompactionSettings()`: about 0.094 ms/call over 1,000 iterations.
- `prepareAsyncCompaction()` on the 273-entry real fixture: about 0.167 ms/call over 200 iterations.
- `buildSessionContext()` on that fixture: about 0.050 ms/call.
- test coverage: 95.05% functions / 93.90% lines overall; production hot modules are mostly above 90% lines.

these costs are negligible beside an llm summary request. optimizing branch copies, settings construction, or token loops now would be premature. the actual unknowns are network/model duration, percentage of ready summaries used, invalidation/wasted-work rate, and user-visible blocking time avoided.

recommendation: build a reproducible benchmark around existing lifecycle events. report p50/p95 for start-to-ready, ready-to-handoff, handoff success, invalidation reason, fallback rate, and estimated synchronous wait avoided. compare extension enabled vs disabled on the same recorded fixture/model. never record prompt or summary text.

### p2 — tests are strong but too mock-centric at lifecycle boundaries

severity: medium; confidence: high

strengths:

- 75 passing tests, zero failures, one intentionally gated real-fixture parity test.
- current parity, timeout, cancellation, replacement, queued-message, forced abort/resume, correlation, and failure paths are covered.
- `bun audit` reports no vulnerabilities; typecheck/check and tarball inspection are clean.

missing regression/integration coverage:

- max thinking parsing and marker acceptance.
- pi retry-policy forwarding and transient retry behavior.
- real `agent_settled` ordering with automatic retry/compaction/queued continuation.
- actual `AgentSession` integration for abort → compaction persistence → one resume, rather than only injected contexts.
- an automated check that the minimum and latest pi versions run explicit parity, not merely compile and run mostly mocked tests.

recommendation: add focused tests for the first three before changing behavior. preserve the existing real fixture; do not add mock theater.

## adoption and conversion audit

### evidence

- npm downloads show discovery, not usage: 1,696 since publication in the earlier checked window, with sustained weekly activity.
- github currently has 0 stars, 0 forks, and 0 watchers.
- last 14 days: 28 clones / 23 unique cloners, but only 9 page views / 7 unique visitors.
- github referrers show only one duckduckgo visitor; no meaningful social/community referral traffic.
- repository topics, npm keywords, pi gallery metadata/image, issue templates, badges, `llms.txt`, and installation instructions are already strong.
- the github repository homepage field is empty; discussions are disabled.
- no public downstream repository, testimonial, issue, or telemetry proves external active use.

interpretation: this is not mainly an seo metadata problem. people/package systems can reach or clone/install it without visiting the github page, while the page offers no quantified proof and only a static promotional image. star conversion cannot happen if almost nobody reaches github.

### ethical conversion plan

1. ship the correctness/current-pi release first. a meaningful `0.1.8` gives promotion a legitimate hook.
2. replace the static “demo” with a 20–30 second real terminal recording: background start, uninterrupted work, ready state, apply, and no synchronous wait.
3. publish a reproducible benchmark with raw method and caveats. lead with measured p50/p95, not “faster” prose.
4. tighten the first screen to problem → measured payoff → demo → one-line install. keep architecture details below.
5. set the github homepage to the pi package page or docs landing page; ensure pi.dev/npm visibly links back to github.
6. add one restrained footer cta: “using this? open feedback or star it so other pi users can find it.” do not front-load begging.
7. enable discussions only if someone will answer them; otherwise issues are enough. add a feedback template asking model, context window, whether a ready summary applied, and observed delay—never conversation contents.
8. announce the release where pi users actually are: the upstream package/community channel, the awesome-pi listing, and one technical post with benchmark/demo. avoid broad generic ai spam.
9. ask actual local/external users for a sentence of feedback and permission to quote it. do not infer testimonials from download counts.
10. treat releases as the recurring distribution loop: concrete changelog, benchmark delta, demo clip, then one community announcement.

## recommended release sequence

### 0.1.8 — correctness and currency

- support `max` thinking.
- update current dev/ci/docs to pi 0.84.4.
- add max-thinking regressions.
- keep the existing peer floor if this release must remain non-breaking.

### 0.2.0 — lifecycle/api modernization

- choose and document a newer minimum pi version.
- use `agent_settled` instead of bounded `agent_end` polling.
- forward retry settings into background `compact()`.
- add real lifecycle integration tests and benchmark tooling.

### launch pass

- real gif/video.
- published benchmark.
- first-screen rewrite and restrained cta.
- github homepage/community links.
- targeted release announcement and user-feedback request.

## verification record

- `bun test`: 75 pass, 1 skip, 0 fail.
- `bun test --coverage`: 95.05% functions, 93.90% lines.
- `bun run typecheck`: clean.
- `bun run check`: clean.
- `bun audit`: no vulnerabilities.
- `bun pm pack --dry-run`: 20 intended files, 128.20 kb unpacked.
- pi 0.80.3 temporary install: typecheck and tests clean.
- pi 0.84.4 temporary install: typecheck and tests clean.
- pi 0.84.4 explicit real parity: 6/6 pass.
- no production source, package metadata, docs, lockfile, or tests were changed by this audit.
