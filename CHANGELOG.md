# changelog

## 0.1.7 — 2026-08-11

- fixed adapter isolation: status keys and job IDs are adapter-scoped; persisted markers now correlate adapter ID, job ID, and prompt version before notification or auto-resume.
- added abort-and-compact handling for eligible over-threshold active turns; made ready-result application idempotent and preserved queued user work by re-checking for pending messages before deferred auto-resume.
- added opt-in structured lifecycle diagnostics for starts, ready results, handoffs, invalidations, failures, durations, and potential/confirmed wasted work.
- added direct configuration and validation-invalidation regressions.
- updated development compatibility to Pi `0.84.1`, verified the supported `0.80.3`–`0.84.1` range, and normalize nullable provider headers at Pi's typed boundary.
- added dependency overrides that remove the package's currently resolvable audit advisories.
- added tagged/unreleased release-consistency and GitHub CI gates for locked verification, real parity, audit, package contents, and the supported Pi matrix.

## 0.1.6 — 2026-07-19

- added experimental `pi-async-compaction/core` adapter api for package authors
- extracted builtin Pi compaction behind the shared async adapter lifecycle
- added adapter migration docs and external adapter smoke coverage

## 0.1.5 — 2026-07-17

- added a pi.dev package gallery preview image
- included preview media in the published package

## 0.1.4 — 2026-07-10

- tuned npm/github description for exact-match discovery queries
- added package-name and Pi coding-agent keywords for npm search
- added context-window and token-management search terms

## 0.1.3 — 2026-07-10

- added `llms.txt` for agent/search discovery
- added async context compaction docs page with exact-match search phrases
- added README FAQ for Pi async/background/context compaction queries
- expanded npm keywords for AI-agent and LLM-context discovery

## 0.1.2 — 2026-07-10

- added README badges and a clearer search-oriented title
- added normal-vs-async comparison table
- added roadmap and changelog links
- added GitHub issue templates

## 0.1.1 — 2026-07-10

- improved package description, README positioning, and search keywords
- added clearer install/demo/why sections
- published as latest npm release

## 0.1.0 — 2026-07-10

- initial public release of `pi-async-compaction`
- precomputes Pi-compatible compaction summaries in the background
- applies ready summaries through Pi's normal compaction flow at safe idle boundaries
- preserves normal `/compact`, threshold, and overflow compaction behavior
