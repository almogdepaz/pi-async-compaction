# agent/search discovery polish

## objective
Make `pi-async-compaction` easier for agents, google, npm, pi.dev, and github search to discover for Pi async/background/context compaction queries.

## status
- [x] inspect existing repo discovery files
- [x] add `llms.txt`
- [x] add/merge repo `AGENTS.md` discovery note if safe
- [x] add docs page with exact-match search phrases
- [x] add README FAQ/search phrases
- [x] expand npm keywords and github topics
- [x] run release gates
- [ ] commit/tag/publish `0.1.3`
- [ ] verify npm/pi.dev/github

## notes
No runtime behavior changes.

`AGENTS.md` already exists as untracked EDC orientation that references untracked `edc-context/`; committing or rewriting it would pollute the package with repo-local agent instructions. Discovery coverage is handled through `llms.txt`, README FAQ, package metadata, and docs page instead.

## verification so far
- `bun test` passed: 48 pass, 1 skip.
- `bun run typecheck` passed.
- `bun run check` passed.
- `bun pm pack --dry-run` packed 15 files as `pi-async-compaction-0.1.3.tgz`.
- `npm view pi-async-compaction@0.1.3 version` returned no package, so patch version is available.
