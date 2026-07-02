# Fix current review findings

## Status

- [x] packaging allowlist
- [x] peer dependency ranges
- [x] private parity import comment
- [x] lifecycle tests for async job state machine
- [x] verification

## Scope

Implement fixes from `project-review-2026-07-01-current.md` only.

## Approach

1. Add lifecycle regression tests first for `startAsyncJob` state transitions.
2. Add minimal dependency injection seam in `src/job.ts` so tests avoid real model calls/settings IO.
3. Add package `files` allowlist and tested peer dependency ranges.
4. Comment the private Pi deep import in tests.
5. Run `bun run test`, `bun run check`, `bun run typecheck`, package dry-run, and Pi load smoke.
