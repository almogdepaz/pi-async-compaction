# 035 chatgpt web compaction backend

status: approved; implementation starting

## goal
route this package's default async summary generation through an authenticated chatgpt web session instead of pi provider authentication, while preserving the existing preparation, validation, handoff, apply, and persistence lifecycle.

## assumptions
- chatgpt web is the default backend.
- the browser uses a dedicated persistent chrome profile and is headed by default for one-time login.
- every compaction uses a fresh chat and the returned assistant markdown becomes pi's summary.
- browser/backend failures fail the async job; they do not silently spend pi provider usage. pi's independent native compaction remains unchanged.
- configuration is environment-based.

## success criteria
- default adapter never calls `ctx.modelRegistry.getApiKeyAndHeaders()`.
- browser transport is isolated behind a small typed interface and can be tested without a real browser.
- prompt generation preserves pi's structured checkpoint format, previous-summary updates, split-turn context, and file-operation lists.
- response extraction correlates the response to the submitted request and rejects login pages, empty output, and incomplete/stalled generation.
- abort and timeout close/cancel browser work cleanly.
- persistent-profile login and configuration are documented.
- focused tests, typecheck, check, and final suite pass.

## plan
1. add failing tests for prompt construction, normal/split compaction, transport failures, and default adapter routing.
2. implement the chatgpt prompt/result builder using pi's exported conversation serialization.
3. implement a lazy playwright browser worker with a dedicated persistent profile, stable semantic selectors, request correlation, abort, and cleanup.
4. wire the default extension adapter to the chatgpt backend; retain the generic adapter API unchanged.
5. update public docs/package metadata and add explicit untested-browser risk documentation.
6. run focused verification, read-only differential review, corrections, then one final repository suite.

## non-goals
- automating account creation or chatgpt login credentials.
- bypassing chatgpt rate limits or anti-automation controls.
- changing pi's cut-point, validation, safe-apply, or persistence semantics.
- adding a second settings system or a general browser automation framework.
