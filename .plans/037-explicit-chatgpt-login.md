# 037 explicit ChatGPT login and safe startup

status: user-approved simplification in progress

## goal
prevent unsolicited ChatGPT windows while retaining an explicit, fail-closed setup path for authenticated web compaction.

## user-approved simplification override
- use `fb08572:src/chatgpt-web.ts` as the complexity baseline and retain only realistic product behavior.
- remove late-promise retention, profile quarantine/drain, filesystem metadata abstractions, no-follow/collision frameworks, navigation state machines, and their tests.
- keep one serializer, straightforward abort/context cleanup, a small private readiness marker, exact ChatGPT URL validation, live structured auth, direct pre-fill/pre-send origin checks, explicit login single-flight/shutdown abort, and no provider fallback.
- verification is focused only; no additional review is requested for this phase.

## decisions
- default `PI_COMPACTION_MODE` to `normal`; only exact `async` opts into extension jobs.
- add `/chatgpt-web-login` as the only path that waits for interactive authentication in headed Chrome.
- after positive `/api/auth/session` validation, write a private non-secret readiness marker inside `~/.pi/chatgpt-web-compaction`.
- ordinary web compaction checks the marker before launching Chrome. missing marker fails before importing/launching Playwright and submits nothing.
- ordinary web compaction still validates `/api/auth/session` before touching the composer. stale auth removes the marker, fails closed, and submits nothing.
- serialize login and compaction through the existing per-profile ownership boundary.
- keep the local package globally uninstalled during implementation and verification.

## success criteria
- new sessions default to normal/native Pi compaction.
- `PI_COMPACTION_MODE=async` remains the explicit startup opt-in.
- missing readiness marker causes no browser launch and no provider fallback.
- login command launches headed Chrome, waits for structured authenticated `user.id`, creates a `0600` marker under a `0700` profile, and closes cleanly.
- stale authentication deletes the readiness marker before returning an actionable failure.
- no prompt is filled or sent until both marker and live structured authentication pass.
- login/compaction access to one profile cannot overlap.
- docs explain setup, opt-in, marker semantics, data upload, and stale-session behavior.
- focused tests, typecheck, source check, and diff check; no additional review or full suite in this simplification phase.
