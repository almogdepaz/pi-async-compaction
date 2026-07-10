# update docs for safe async apply

## objective
Update repository docs so they match current async compaction behavior after safe idle-boundary application.

## status
- [x] inspect current README/design docs
- [x] update README behavior/config wording
- [x] update design doc hooks/state/apply wording
- [x] run docs sanity checks

## notes
Previous docs incorrectly said ready async summaries immediately trigger Pi compaction. Current docs now describe:
- background summary starts at async threshold.
- ready summary applies only when Pi is idle and has no queued messages.
- `agent_end` is the safe retry boundary.
- manual `/compact` and Pi threshold/overflow compaction still use `session_before_compact` handoff.
- `START_RATIO=0.5` is documented as an optional early-start setting while noting the built-in default remains `0.8`.

## verification
- `rg` checked for stale immediate/default wording in `README.md` and `ASYNC_COMPACTION_DESIGN.md`.
- `bun run check` passed.
