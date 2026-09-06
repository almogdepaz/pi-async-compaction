# fix project review findings

status: completed

## scope
- fix findings from `project-review-2026-07-01.md`
- touch only source/tests/docs required for those fixes

## tasks
- [x] tokensBefore parity: added regression, switched preparation to Pi-style usage-aware accounting via exported `calculateContextTokens()` plus trailing-token estimates
- [x] timeout reason: added regression/helper coverage and `timeout` invalidation reason
- [x] status output: added shared formatter and non-ui `console.log` fallback
- [x] run full verification

## verification
- red: `bun test src/index.test.ts` initially failed on missing new runtime-state exports
- green: `bun test src/index.test.ts` passed, 11 tests
- full: `bun run test && bun run check && bun run typecheck` passed
- smoke: `PI_ASYNC_PREFIX_COMPACTION=0 pi -e . --version` printed `0.78.1`
