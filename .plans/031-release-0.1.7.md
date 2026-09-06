# release 0.1.7

baseline: merged `origin/main` at `cdcb61ebfbf4b53abf9de3a5fd1b5a7497377d1d`

goal: publish the already-reviewed 0.1.7 package safely to npm and GitHub.

## steps

1. align local main with merged origin/main without touching unrelated untracked files.
2. add a failing release-consistency regression for the untagged release-preparation state.
3. support release preparation, date the 0.1.7 changelog, point README Git install at v0.1.7, and make CI fetch tags.
4. run full tests, coverage, typecheck, syntax, real parity, audit, package dry-run, and release checks in both prep/tagged states.
5. commit the release metadata, create annotated tag v0.1.7, and atomically push main plus the tag.
6. require successful GitHub CI before publishing npm.
7. publish pi-async-compaction@0.1.7, verify the registry, and create the GitHub release.

## constraints

- preserve all unrelated untracked files.
- no EDC changes.
- stop before publish if verification, CI, npm ownership/auth, packed contents, or version checks fail.
- do not publish or tag any version other than 0.1.7.
