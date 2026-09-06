# correction review: 037 explicit chatgpt login and safe startup

## verdict

**block: three high-severity lifecycle/security gaps remain.** the corrections resolve most of the original report: exact startup opt-in, command single-flight/deadline linkage, prompt aborts at every browser phase, atomic private marker validation/publication, lazy exact-origin config validation, and initial/post-auth origin checks are present. remaining failures are cleanup-error ownership, shutdown draining, and navigation races between the last origin check and composer submission.

## prior finding disposition

| original finding | disposition | evidence |
| --- | --- | --- |
| browser acquisition/page/navigation/auth cancellation | **partial** | phase promises now reject promptly and retain profile ownership through late settlement (`src/chatgpt-web.ts:595-665`), but retained cleanup failures are discarded and release the profile (`src/chatgpt-web.ts:176-199`). |
| command lifecycle/deadline/duplicates | **partial** | owned controller, deadline, context-signal linkage, and duplicate rejection are implemented (`src/index.ts:75-111`); shutdown aborts but does not await the operation or retained profile cleanup (`src/index.ts:114-116`). |
| transactional private readiness marker | **resolved** | login clears prior readiness, closes successful browser work before publication, creates an exclusive no-follow `0600` same-directory temp, validates exact regular-file/schema/modes, atomically renames, and removes temp/final paths on cancellation/failure (`src/chatgpt-web.ts:81-123`, `src/chatgpt-web.ts:388-508`, `src/chatgpt-web.ts:680-710`). |
| configurable URL trust | **partial** | lazy config validation requires credential-free exact origin `https://chatgpt.com`, and ordinary compaction checks origin before body/auth and after auth (`src/chatgpt-web.ts:243-263`, `src/chatgpt-web.ts:731-765`); auth provenance and composer-time navigation are still racy. |

## remaining findings

### high — failed context cleanup releases profile ownership and can permit an overlapping successor

- where: `src/chatgpt-web.ts:176-199`, `src/chatgpt-web.ts:585-665`; misleading unconditional cleanup claim at `README.md:203`
- consequence: every retained promise is wrapped in `Promise.allSettled`, both when `withBrowserPage` builds its retention group at lines 655-659 and when the profile releases at line 198. if an acquired or late-acquired persistent context's `close()` rejects, that failure counts as settled and the profile tail is released. the original browser may still own the persistent profile, yet a queued login or compaction is then allowed to call `launchPersistentContext` for the same directory. the normal success path reports a close error, but the abort/operation-error paths discard it entirely; neither path preserves exclusive ownership after uncertain teardown.
- smallest fix: distinguish “wait for phase settlement” from “cleanup must succeed.” phase rejection caused by context closure may be consumed, but a context-close rejection must poison/quarantine that profile (or otherwise make successors fail closed) until ownership is explicitly re-established. preserve the primary operation error while reporting/recording the cleanup error; do not convert cleanup rejection into successful queue release.
- regression coverage: make late-launch close, acquired-context abort close, and close-after-operation-error reject. assert a successor never launches after the close failure and that the cleanup failure remains observable. the current close-failure test (`test/chatgpt-web-login.test.ts:881-905`) checks only which error reaches the first caller, not successor exclusion.

### high — `session_shutdown` returns before login and late browser cleanup are drained

- where: `src/index.ts:46-116`, especially `src/index.ts:114-116`
- consequence: pinned pi `0.84.4` awaits async `session_shutdown` handlers before tearing down the runtime, but this handler is synchronous and only calls `abort()`. `loginToChatGptWeb` intentionally rejects promptly while `runSerializedByProfile` may retain a late launch, `newPage`, navigation/auth operation, or context close after caller rejection. pi can therefore finish reload/session replacement/exit while the old extension still owns or is still acquiring headed Chrome. a marker publication already in progress can also finish and clean up after shutdown has returned. this violates the session resource lifecycle despite duplicate/deadline handling being correct.
- smallest fix: make shutdown async and await both the command operation and the profile-ownership drain, including late-settlement context cleanup. awaiting only `chatGptLoginState.promise` is insufficient because that promise rejects before retained cleanup completes; expose/store a separate drain promise or an explicit per-profile drain primitive. preserve core's existing shutdown invalidation handler ordering.
- regression coverage: hold a late context acquisition/close and invoke the combined shutdown handler. assert the shutdown promise remains pending until close settles, then resolves; also assert no marker exists and no browser launch occurs after shutdown resolution. the current tests (`test/index.test.ts:141-211`) await the login command separately after the shutdown handler and therefore prove abort dispatch, not shutdown drainage.

### high — redirects can swap the authenticated document before composer fill/send

- where: `src/chatgpt-web.ts:256-263`, `src/chatgpt-web.ts:279-301`, `src/chatgpt-web.ts:313-321`, `src/chatgpt-web.ts:746-778`
- consequence: normal compaction snapshots `page.url()` after navigation and again after `hasAuthenticatedSession`, then performs multiple awaits (`assistantResponses.count`, composer visibility, fill, click) without a main-frame navigation guard or another trusted-origin check. a cross-origin navigation after line 760 can expose `request.prompt` to an attacker-controlled `#prompt-textarea` at line 772. separately, the auth probe returns only session JSON: a trusted page can navigate away before `page.evaluate`, an untrusted origin can return a valid-shaped `user.id`, and the page can return to ChatGPT before the outer post-auth URL snapshot. live structured auth is therefore not cryptographically/structurally bound to the document whose composer is used.
- smallest fix: for ordinary compaction, install a main-frame `framenavigated` guard before navigation and abort/close immediately on every non-ChatGPT origin through completion; remove it during teardown. have the page evaluation return both `location.origin` and the session payload and require the captured origin to be trusted. retain direct checks immediately before fill and click as defense in depth. login may continue allowing external identity pages, but must likewise bind a successful auth result to the origin captured inside the evaluation.
- regression coverage: navigate away (a) between the pre-auth origin check and auth evaluation, (b) after auth returns but before composer visibility resolves, and (c) between fill readiness and click. assert no prompt fill/send, readiness removal for ordinary compaction, and context closure. current redirect tests (`test/chatgpt-web-login.test.ts:323-370`) vary only the two explicit `page.url()` snapshots and do not exercise navigation during the later awaits.

## resolved areas / no new finding

- **exact async opt-in and native mode:** only exact lowercase `PI_COMPACTION_MODE=async` enables extension work; normal mode keeps core starts/handoffs inactive and does not import or launch Playwright.
- **missing marker ordering:** ordinary transport validates the real `0700` profile and no-follow exact `0600` marker before URL parsing, browser loading, or launch (`src/chatgpt-web.ts:407-446`, `src/chatgpt-web.ts:728-735`). invalid config plus missing readiness still fails at readiness.
- **marker privacy/integrity:** marker schema is exact and contains no account/cookie/token/prompt data. permissive paths, profile/marker symlinks, non-regular markers, malformed/wrong/extra schema, temp collisions, chmod/write/rename failure, and cancellation cleanup have deterministic coverage.
- **command concurrency/deadline:** state is installed before the deferred login call, so concurrent commands cannot race past the duplicate guard. idle commands receive an owned timeout, optional `ctx.signal` is linked and removed, timers/state clear in `finally`, and a queued login observes shutdown abort before entering the profile operation.
- **phase abort behavior:** loader abort prevents launch and may release immediately because no launch continuation is chained. launch/newPage/navigation/auth/teardown aborts reject the caller promptly while retaining ownership through the relevant late phase and close settlement. navigation receives the pinned Playwright signal and remaining deadline; browser-side auth fetch receives a remaining-deadline abort timer.
- **headed login/auth semantics:** login forces headed Chrome, does not probe external identity pages, and publishes readiness only after returning to ChatGPT with structured non-empty `user.id` and successful context teardown. the auth-origin binding race is limited to the remaining finding above.
- **stale auth and provider isolation:** ordinary negative auth or detected redirect clears readiness before failure and never reaches provider fallback. the comparison command still intentionally invokes both named backends.
- **test browser isolation:** all new browser behavior uses injected fakes; test imports are type-only and no reviewed deterministic test path intentionally launches Chrome.
- **docs:** setup, exact opt-in, data upload, marker semantics, allowed configured URL, external identity behavior, stale auth, redirects, and no fallback are documented. only the unconditional cleanup guarantee remains unsupported when `context.close()` rejects.
- **correction complexity:** the ~600-line browser/file lifecycle expansion is substantial but mostly earned by explicit ownership, deadlines, atomic publication, and injectable deterministic boundaries. no independent style-only blocker was recorded; the two lifecycle findings are concrete places where the new ownership model still fails closed incorrectly.

## verification and limits

- fresh static review covered the current source, tests, docs, plan/status, every prior finding, pinned pi command/shutdown behavior, and pinned Playwright navigation/context APIs.
- `git diff --check` passed before this report update.
- no production/test/doc edits, agents, installs, commits, pushes, provider calls, or browser launches were performed.
- no tests were rerun: the remaining defects are directly demonstrated by control flow and existing tests do not contain the required failure/race fixtures. implementer ledger pass counts were treated as non-independent evidence only.
