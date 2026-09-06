# fix review refresh findings

status: completed

## scope
- fix findings from `project-review-2026-07-01-refresh.md`
- touch only source/tests/status docs required

## tasks
- [x] add failing regression for empty async preparation
- [x] add failing regression for zero-usage token accounting
- [x] add parity sentinel tests against installed Pi preparation/accounting internals
- [x] implement minimal production fixes
- [x] run focused + full verification

## verification
- red: `bun test src/index.test.ts` failed on empty preparation returning an object and zero-usage accounting returning `0` instead of Pi's `12347`
- green focused: `bun test src/index.test.ts` passed, 17 tests
- full: `bun run test` passed, 17 tests / 53 expects
- check: `bun run check` passed
- typecheck: `bun run typecheck` passed
- smoke: `PI_ASYNC_PREFIX_COMPACTION=0 pi -e . --version` printed `0.78.1`
