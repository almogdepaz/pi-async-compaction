# async compaction: reuse pi compaction

status: implemented; awaiting user verification

## goal
make async compaction use Pi's built-in compaction generation so output quality matches sync compaction, while applying only if the current branch can safely append the raw tail from the snapshotted `firstKeptEntryId`.

## tasks
- [x] replace custom summary prompt/model call with Pi `compact()`
- [x] mirror Pi preparation locally because `prepareCompaction()` is not exported by the package
- [x] snapshot validation metadata: session, leaf, first kept, model, thinking level, settings
- [x] validate/apply stored `CompactionResult` through `session_before_compact`
- [x] support split-turn preparation and file-operation extraction for Pi `compact()`
- [x] allow stale/ready replacement when the ready result no longer fits or metadata drift makes it unusable
- [x] use actual event compaction settings for apply fit check
- [x] verify type/runtime constraints possible in this repo

## notes
- no local test harness exists.
- `prepareCompaction()` is present internally in Pi but not exported from `@earendil-works/pi-coding-agent`; if Pi exports it later, the local mirrored preparation should be deleted.
