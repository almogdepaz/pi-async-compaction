# release 0.1.8

baseline: merged `origin/main` at `dc0c8a1`

goal: publish the reviewed Pi 0.84 compatibility and lifecycle update as `pi-async-compaction@0.1.8`.

## steps

1. sync local `main` with merged `origin/main` while preserving unrelated untracked files.
2. bump package metadata and release-consistency fixtures to `0.1.8`.
3. add the dated `0.1.8` changelog and update the README Git install tag.
4. run focused release-consistency checks, then the final full release gate once.
5. obtain independent read-only review of the release diff.
6. commit release metadata, create annotated tag `v0.1.8`, and atomically push `main` plus the tag.
7. require successful GitHub CI before npm publication.
8. publish `pi-async-compaction@0.1.8`, verify the registry, create and verify the GitHub release, and verify local installation.

## constraints

- preserve all unrelated untracked files.
- do not commit EDC context, reports, AGENTS.md, or prior plan artifacts.
- stop before publication if verification, CI, npm ownership/auth, packed contents, or version checks fail.
- publish and tag only `0.1.8`.
