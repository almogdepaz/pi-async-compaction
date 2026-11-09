# stable Pi 1.x compatibility release

## scope and status

- user authorizes compatibility changes, regression tests, scoped commit/push/tag/npm publication; no new agent sessions or unrelated changes.
- assumption: update stable plugin, do not promote Astra. isolated worktree `/Users/home/Dev/pi_compaction-release`, branch `release/pi-1.x-compat`, base `v0.1.8` / `5b9a70b678f23b7250f66b97789cb2777061cf3c`.
- original checkout `/Users/home/Dev/pi_compaction` and its concurrent work remain untouched. remote main rechecked at `56fcd5f66cd57b3bb2491b5ea9133a0a0f0d7b9b`; do not merge or push main.
- target: stable `0.1.9`; npm latest remains `0.1.8`, Astra remains `0.1.9-astra.3` before publication.
- current upstream Pi is `1.5.0`; active installed Pi is `1.4.0`. declare only verified exact releases: `1.3.0 || 1.4.0 || 1.5.0`.
- private command evidence: `/tmp/pi-compat-release.QbHJFb`.
- status: local implementation, matrix, review and immutable package verification complete; commit/remote CI/publication pending.

## plan and commit boundary

1. completed: inspect current Pi docs, exported APIs, history and stable tests; establish failing compatibility coverage.
2. completed: minimal stable-plugin changes, tested exact peer declarations, CI/docs/version/lockfile updates.
3. completed locally: regression/parity/typecheck, final full matrix, audit, release consistency and isolated package-load checks.
4. pending: one scoped source/release commit; push maintenance branch, verify existing CI, then push version tag, publish the tested tarball to npm latest and create a stable GitHub release. do not change Astra or merge main.
5. pending: verify registry artifact/peers, remote tag and release; update this ledger in an evidence-only follow-up commit on the maintenance branch. never move the release tag for ledger updates.

ordinary API adaptation, fixture corrections and version bump are authorized. stop for unavailable credentials, incompatible design choices or untestable release risk. no live model requests, credential changes, or local Pi installation changes.

## changes and decisions

- `src/job.ts`: dispatch compaction through `ctx.modelRegistry.streamSimple`; accept successful native auth without assuming a string key/header. retain failed-auth rejection and header/base URL/environment/retry forwarding.
- `src/utils.ts`: pass the current model to Pi's settings resolver; use public session projection to detect retained context edits.
- `src/preparation.ts`, `src/validation.ts`, `src/constants.ts`: defer edited context to Pi's native synchronous compaction and reject pre-edit ready summaries. resume async preparation after edits leave the retained projection. exclude system messages and preserve nested codemode file operations.
- regression/integration tests cover those contracts, real native providers, auth rejection, retry/abort, projected synchronous fallback, package loading and real AgentSession abort/apply/resume. parity now compares complete message arrays, not only roles.
- Pi 1.x pins runtime siblings exactly. removed obsolete CI installs of nonexistent 1.x `pi-client`/`pi-protocol` packages; matrix selects the three public peers together.
- audit exposed a historical `brace-expansion@5.0.9` override with two high and one moderate advisory. updated the override to Pi's own `5.0.12` pin; final audit passes.
- stable `0.1.9` excludes Astra work. older Pi 0.84 hosts retain plugin `0.1.8`.

## evidence

all final checks below exited 0 unless explicitly noted.

| scope | result | private evidence |
| --- | --- | --- |
| original compatibility regression | seven intended failures before fixes | `compat-red-corrected.log` |
| native-provider regression | intended missing-auth failure before fix; passes after fix | `native-provider-red.log`, `native-provider-green.log` |
| Pi 1.3.0 full suite, real parity enabled | 100 pass, 0 fail, 268 assertions | `full-1.3.0.log` |
| Pi 1.4.0 full suite, real parity enabled | 100 pass, 0 fail, 268 assertions | `full-1.4.0.log` |
| Pi 1.5.0 full suite, real parity enabled | 100 pass, 0 fail, 268 assertions | `full-1.5.0.log` |
| strict typecheck, each host | pass | `typecheck-final-1.3.0.log`, `typecheck-final-1.4.0.log`, `typecheck-final-1.5.0.log` |
| locked install, syntax, release consistency | pass | `frozen-install.log`, `syntax.log`, `release-check.log` |
| dependency audit | zero vulnerabilities across 120 packages | `audit.log`; original failure retained in `audit-initial.log` |
| archive and publish dry-run | 20 intended files, no tests/plans/dependencies/secrets | `pack.log`, `pack-dry.log`, `publish-dry.log` |
| Node v24.1.0 packed-extension load and real async compaction | pass on each host; four native faux-provider calls, one persisted hook compaction | `packed-smoke-final-1.3.0.log`, `packed-smoke-final-1.4.0.log`, `packed-smoke-final-1.5.0.log` |
| security differential review | no security findings in reviewed scope | `.plans/pi-1.x-security-review.md` |

- immutable archive: `/tmp/pi-compat-release.QbHJFb/pi-async-compaction-0.1.9.tgz`.
- SHA-256: `a6470fc9c1eb3eb612bfa882646ee620f636caf9f8aacb39908fb8025752fb64`.
- SHA-1: `107cf156dfc44ffa7a2ed3b4c307be5237efb0f9`.
- initial packed smoke failed because split-turn compaction needed two summary responses, but the test supplied one. diagnostic showed four provider calls. corrected only the private fixture; no production workaround. initial logs retained.
- attempted old runtime-family installation failed for nonexistent Pi 1.x client/protocol versions; exact dependency manifests confirmed the corrected CI approach. failure logs retained.
- npm/GitHub identities resolve; dry-run is not proof of publication permission or completed release.

## limits and remaining work

- no live provider requests or interactive desktop testing; deterministic native transports cover API wiring, auth failure, retry, cancellation and persistence.
- local tests used Bun 1.4.2. existing CI pins Bun 1.3.9; remote CI is still a release gate.
- install scripts stayed disabled locally; blocked dependency lifecycle scripts are not required by these checks.
- self-review only: the user disallows additional sessions.
- context-edited branches deliberately lose async preparation until native compaction moves past retained edits.
- pending remote CI, publication and public artifact verification; do not infer them from local checks.
