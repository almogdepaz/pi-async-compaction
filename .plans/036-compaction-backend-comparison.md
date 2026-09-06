# 036 compaction backend comparison

status: approved; implementation starting

## goal
allow an operator to run provider-backed and ChatGPT-web compaction against the same immutable preparation, compare both outputs side by side without applying either result, and independently choose the backend used by ordinary async compaction.

## decisions
- add `/async-compact-compare` for explicit dual generation.
- prepare once, then run provider and web generation concurrently from the same preparation.
- comparison never hands either result to Pi's apply/persistence lifecycle.
- write private raw Markdown, metadata, and a side-by-side HTML report under `~/.pi/compaction-comparisons/`, then open the HTML report on macOS.
- preserve a successful result when the other backend fails.
- add `/compaction-mode normal|async`; default remains `async` and `PI_COMPACTION_MODE` selects the startup mode. normal mode leaves Pi's native compaction path authoritative and starts/applies no extension work.
- add `/async-compaction-backend provider|web`; default remains `web` and `PI_ASYNC_PREFIX_COMPACTION_BACKEND` selects the startup default.
- switching mode or backend invalidates pending/ready work before future jobs use the selected configuration.
- provider comparison explicitly uses Pi provider authentication/usage; web comparison explicitly uploads the same compacted context to ChatGPT.

## success criteria
- both comparison calls receive the exact same `LocalCompactionPreparation` object.
- neither comparison output can be applied as a ready compaction.
- reports escape untrusted Markdown/error content and use private filesystem permissions.
- partial failures are visible and retain the successful output.
- backend selection is snapshotted per async job and cannot mix preparation/run/result conversion across backends.
- mode and backend are independent: normal mode disables extension jobs without changing the selected async backend.
- changing mode or backend cancels/stales active work and clears its status.
- commands and environment parsing have focused tests.
- provider/web adapter routing, comparison identity, reports, failure handling, and no-apply behavior have focused tests.
- focused verification, independent review, corrections, then one final suite.

## non-goals
- automatically scoring or selecting a winner.
- applying either comparison result.
- changing Pi's native `/compact` behavior.
- persisting backend selection into Pi settings.
- bypassing provider or ChatGPT authentication/rate limits.
