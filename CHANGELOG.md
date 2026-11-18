# changelog

## 0.1.10 — 2026-11-18

- removed the Astra remote-context prerelease line and its patched-host checkpoint hook; `0.1.9-astra.*` versions are no longer maintained.
- stopped aborting active model or tool work to apply a ready summary. over the async threshold, a ready job is now proposed as a stock Pi `turn_end` compaction draft at a completed, non-cancelled boundary that continues; final replies apply after `agent_settled`. no `continue` message is sent.
- confirmed boundary drafts from the branch after the proposal leaf, because Pi emits no `session_compact` event for them; an unpersisted draft records an apply failure.
- removed the unused `continue` auto-resume path and its runtime state.
- widened peer dependencies to `^1.3.0` so newer Pi 1.x releases are supported without a package update; CI also tests the newest Pi release. verified locally on Pi `1.4.0`, `1.5.0`, and `1.5.2`.
- revalidated a boundary draft against Pi's boundary projection, so context edits or compaction drafts proposed at the same boundary fall back to synchronous compaction.

## 0.1.9 — 2026-11-09

- verified compatibility with Pi `1.3.0`, `1.4.0`, and `1.5.0`; limited peer dependencies and CI to those tested releases.
- route background compaction through the session's native provider registry, including providers whose successful authentication does not return an API key or headers.
- honor per-model compaction settings, exclude system messages from summaries, and preserve nested codemode file-operation metadata.
- defer context-edited branches to Pi's synchronous compaction and invalidate summaries prepared before an edit.
- this stable maintenance release does not include Astra prerelease features; the Astra channel remains separate.

## 0.1.8 — 2026-08-31

- aligned ready-summary application with Pi `0.84`'s `agent_settled` lifecycle and added correlated handling for extension compaction failures.
- forwarded trusted-project settings, retry policy, resolved provider headers/base URLs, header-only authentication, and the `max` thinking level through async compaction.
- raised the supported Pi range to `0.84.3`–`0.84.4` and added real-session lifecycle, retry, authentication, and compatibility coverage.

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
