# audit findings remediation

## goal
address the verified correctness and compatibility findings from:

- `.plans/032-performance-upstream-adoption-audit.md`
- `.plans/032-independent-review.md`

without mixing a breaking Pi compatibility-floor change into the immediate correctness patch.

## assumptions

1. immediate scope is production correctness, regressions, current-version metadata, and CI parity—not marketing assets, promotion, telemetry, or provider benchmarks.
2. phase 1 retains Pi `0.80.3`; approved phase 2 raises the declared floor to `0.84.3` for retry and lifecycle APIs.
3. local compaction preparation remains mirrored because Pi does not publicly export `prepareCompaction`.
4. no commits, pushes, package version bump, or release publication without explicit approval.

## success criteria

- valid Pi `max` thinking survives session reconstruction and persisted marker validation.
- background compaction preserves resolved `baseUrl`, accepts header-only authentication, applies resolved header overrides/deletions case-insensitively, preserves nullable deletion markers through Pi's compaction boundary, and still rejects requests with neither an API key nor usable headers.
- development/current CI uses Pi `0.84.4`.
- deterministic preparation/result parity runs at both minimum and current Pi compatibility endpoints.
- focused regressions, full tests, typecheck, source check, audit, release consistency, and package dry-run pass.
- breaking lifecycle modernization remains explicitly gated on the minimum-version decision.

## phase 1 — correctness and current compatibility

- [x] 1. add failing regressions for `max` thinking reconstruction and marker acceptance.
- [x] 2. minimally extend the validated thinking-level domain to include `max`; run focused tests.
- [x] 3. add failing regressions for resolved `baseUrl`, header-only auth, and missing auth material.
- [x] 4. minimally align `buildAsyncCompactionResult` with Pi's resolved request auth contract; run focused tests.
- [x] 5. update exact development dependencies/current CI/docs from Pi `0.84.1` to `0.84.4` using Bun.
- [x] 6. enable explicit deterministic parity in the compatibility matrix at both `0.80.3` and `0.84.4`.
- [x] 7. run focused compatibility checks, then the final repository verification gate once.
- [x] 8. obtain independent read-only review of the resulting diff; fix verified findings sequentially.

## phase 2 — breaking lifecycle modernization

approved minimum Pi version: `0.84.3`, the simplest coherent floor exposing all required APIs.

- [x] decide and document the new minimum Pi version.
- [x] raise the peer, CI, and documentation minimum to Pi `0.84.3` while retaining `0.84.4` as current.
- [x] forward the effective Pi retry policy into background compaction.
- [x] add transient retry/abort regressions.
- [x] replace bounded `agent_end` polling with `agent_settled` and focused ordering regressions.
- [x] correlate `session_compact_failed` only to this adapter's passive handoff; clear terminal state and emit one failure.
- [x] add actual `AgentSession` integration coverage for abort → persisted compaction → exactly one resume.

## phase 3 — evidence and adoption (separate scope)

- [ ] add privacy-preserving outcome benchmarks for latency, handoff, invalidation, fallback, and synchronous wait avoided.
- [ ] publish benchmark method/caveats and a real terminal recording before promotional claims.
- [ ] improve repository/package linkage and use only organic feedback/star requests.

## deferred/non-findings

- supported Pi `0.84.3`–`0.84.4` publicly narrows `compact()` headers to string-only even though its runtime forwards pi-ai `ProviderHeaders`; phase 1 contains one documented narrow cast to preserve required null deletion markers.
- no CPU micro-optimization: measured local preparation/settings overhead is sub-millisecond.
- no production deep import of Pi's private preparation helper.
- no direct `turn_end` compaction while queued work exists.
- no claim that downloads/clones prove external adoption.
