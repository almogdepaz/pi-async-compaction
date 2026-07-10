# package visibility polish

## objective
Make `pi-async-compaction` more discoverable on pi.dev/npm/github by improving package metadata, README first-screen value proposition, keywords, install clarity, and repo topics.

## status
- [x] update npm description/version/keywords
- [x] rewrite README top section for user value
- [x] add why/best-for/demo sections without fake media
- [x] run release gates
- [ ] commit/tag/publish patch release
- [ ] verify pi.dev/npm/github visibility metadata

## notes
No behavior changes. Do not fabricate screenshots/gifs; add honest demo copy and leave room for real media later.

## verification
- `bun test` passed: 48 pass, 1 skip.
- `bun run typecheck` passed.
- `bun run check` passed.
- `bun pm pack --dry-run` packed 12 files as `pi-async-compaction-0.1.1.tgz`.
- `npm view pi-async-compaction@0.1.1 version` returned no package, so patch version is available.
