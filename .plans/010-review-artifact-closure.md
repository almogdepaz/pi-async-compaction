# review artifact closure

## objective
Close out plan/report follow-ups by reconciling historical findings against current repo state, without changing production code and without touching peer dependency ranges.

## status
- [x] audited all plan files in `.plans/`
- [x] audited review/security/antipattern reports in repo root
- [x] verified current gates
- [x] identified findings already fixed
- [x] identified intentionally deferred/external items
- [x] peer dependency ranges fixed after follow-up request

## verification evidence
Fresh verification on 2026-07-02:

```bash
bun test
bun run typecheck && bun run check
PI_RUN_REAL_COMPACTION_PARITY=1 bun test src/index.test.ts -t "real long edc conversation"
bun pm pack --dry-run
node - <<'JS'
const pkg = require('./package.json');
const expected = '>=0.80.3 <0.81.0';
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent']) {
  if (pkg.peerDependencies?.[name] !== expected) throw new Error(`${name} mismatch`);
}
JS
PI_ASYNC_PREFIX_COMPACTION=0 pi -e . --version
```

Observed:
- default tests: 42 pass, 1 skipped opt-in parity, 0 fail
- typecheck/check: pass
- opt-in real long fixture parity: pass
- package dry run: 12 files, 44.40 KB; no `.plans`, `.edc`, reports, or tests shipped
- peer dependency range check: pass (`>=0.80.3 <0.81.0`)
- global Pi smoke after local Pi update: `0.80.3`

## artifacts reviewed
Plans:
- `.plans/001-reuse-pi-compaction.md`
- `.plans/002-review-skills.md`
- `.plans/003-fix-review-findings.md`
- `.plans/004-fix-review-findings.md`
- `.plans/005-fix-review-refresh-findings.md`
- `.plans/006-fix-current-review-findings.md`
- `.plans/007-public-release-prep.md`
- `.plans/008-fix-review-findings-2026-07-02.md`
- `.plans/009-static-compaction-parity-test.md`

Reports:
- `async-compaction-review.md`
- `review-report.md`
- `project-review-2026-07-01.md`
- `project-review-2026-07-01-refresh.md`
- `project-review-2026-07-01-current.md`
- `project-review-2026-07-01-latest.md`
- `antipattern-report-repo-2026-07-01.md`
- `antipattern-report-repo-2026-07-01-rerun.md`

## closure matrix

### fixed / covered
- custom async prompt/file-op quality gap: fixed by using Pi `compact()` and preserving Pi details.
- previous-summary merge semantics: fixed by Pi compaction path reuse.
- ready/stale lifecycle replacement risk: covered by lifecycle tests and ready-job replacement tests.
- fit validation using env reserve: fixed; apply validation uses event preparation settings.
- split-turn async gap: fixed/covered by Pi-compatible split-turn preparation parity tests.
- typecheck/test harness absence: fixed; `bun test`, `bun run typecheck`, `bun run check` exist and pass.
- `tokensBefore` parity drift: fixed with usage-aware accounting and parity sentinels.
- status command non-UI silence: fixed with formatter/console fallback.
- timeout vs cancellation reason: fixed with `timeout` invalidation reason.
- empty async preparation: fixed; returns no preparation like Pi.
- zero-usage assistant undercount: fixed; parity sentinel covers fallback behavior.
- package dry-run shipping plans/reports/tests: fixed with `package.json.files` allowlist.
- false notification for other extensions: fixed; `session_compact` checks async marker.
- duplicated `firstKeptEntryId` consistency: fixed; validation rejects mismatch.
- stale design doc token/invalidation text: fixed; design doc mentions usage-aware token accounting and `timeout`.
- no-gap post-apply raw tail invariant: fixed/covered by regression using Pi `buildSessionContext`; live session check also found exact raw sequence match.

### intentionally deferred / excluded
- npm publish / making GitHub repo public / npm install verification: external side effects requiring separate explicit approval.
- local clone of Pi `prepareCompaction()` internals: accepted until Pi exports the needed preparation API; parity sentinels remain.
- test-only private deep import into Pi internals: accepted sentinel because no public export exists.

## remaining actionable gaps
1. Release side effects remain pending until explicitly approved.

## note on historical reports
Historical review reports were not rewritten. Their findings are preserved as audit evidence; this file records current disposition against the live repo.
