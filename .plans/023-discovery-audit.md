# discovery audit

## objective
Check how discoverable `pi-async-compaction` is across package/search surfaces and identify concrete next steps to improve exposure.

## status
- [x] npm search checks
- [x] github search checks
- [x] pi.dev package/search checks
- [x] public search engine checks where accessible
- [x] tune metadata for exact-match search phrases
- [ ] publish patch release
- [ ] summarize gaps and next actions

## findings
- DuckDuckGo does not show the package yet for exact or phrase searches. This is expected for a same-day package/repo.
- npm package metadata resolves and latest is `0.1.3`, but npm search API does not return `pi-async-compaction` in the top 100 for `pi-async-compaction`, `pi async compaction`, or `pi context compaction`. It only appears via `maintainer:sgtbeatdown`. This looks like search index lag/ranking, not publish failure.
- GitHub repo search returns `almogdepaz/pi-async-compaction`, but `pablopunk/pi-async-compaction` currently ranks above it for exact package-name search.
- pi.dev package detail page resolves and install command exists, but cache/listing behavior can lag npm.

## immediate action taken
Improved metadata exact-match density for `0.1.4`:
- description includes `async context compaction` and `Pi coding agent`
- keywords include `pi-coding-agent`, `pi-async-compaction`, `async-context-compaction`, `context-window`, and `token-management`
- GitHub description uses the same exact phrasing

## verification so far
- `bun test` passed: 48 pass, 1 skip.
- `bun run typecheck` passed.
- `bun run check` passed.
- `bun pm pack --dry-run` packed 15 files as `pi-async-compaction-0.1.4.tgz`.
- `npm view pi-async-compaction@0.1.4 version` returned no package, so patch version is available.
