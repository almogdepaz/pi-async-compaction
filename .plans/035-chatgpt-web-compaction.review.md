# final narrow correction re-review: markdown extraction and README

scope: latest markdown-extraction and README correction diff only. static, read-only review; no tests run.

## prior findings

### resolved — rendered response text dropped assistant markdown
- evidence: `src/chatgpt-web.ts:163-176` scopes extraction to the selected assistant response's `.markdown` descendant, rejects zero or multiple matches and empty converted output, then `src/chatgpt-web.ts:224-226` waits for completion and returns that markdown. `src/chatgpt-web.ts:73-76` converts rendered HTML with ATX headings and fenced code blocks.
- consequence: the persisted summary now retains markdown rather than the prior rendered plain text.
- smallest follow-up: none.

### resolved — README overclaimed selector coverage
- evidence: `README.md:189` now limits deterministic coverage to prompt, result, and conversion helpers, and explicitly leaves real selectors, session checks, and UI behavior to manual headed-Chrome verification.
- consequence: docs now match the test boundary.
- smallest follow-up: none.

### resolved — clipboard capability and prior-value correlation
- evidence: no direct clipboard API or permission reference exists in `src/`, tests, package manifest, README, or design docs. The conversion path reads only response-local `innerHTML` at `src/chatgpt-web.ts:163-176`.
- consequence: no system clipboard read, grant, write, or same-value false rejection is reintroduced.
- smallest follow-up: none.

## dependency and fidelity checks

- **dependency choice:** no verified finding. `turndown` is a direct production dependency (`package.json:95-97`) and its typings are development-only (`package.json:82-89`); both are locked (`bun.lock:7-18,122,168,288`). It is a small purpose-built HTML-to-Markdown converter rather than a custom parser.
- **`.markdown` scoping/count:** no verified finding. `extractCompletedAssistantMarkdown` scopes `.markdown` below the correlated post-send assistant locator, requires exactly one match, and fails closed for zero, ambiguous, or empty content (`src/chatgpt-web.ts:163-176`).
- **HTML-to-Markdown fidelity:** no verified finding. `test/chatgpt-compaction.test.ts:106-120` covers heading, emphasis, list, link, and language-tagged fenced-code preservation through the production converter helper.
- **docs wording:** no verified finding in the latest README correction; it now accurately distinguishes helper coverage from real-browser/manual coverage (`README.md:189`).

## reviewed areas with no new blocker/important regression

- default Pi authentication remains absent from the ChatGPT default route.
- authenticated-session endpoint shape and live selectors remain external/manual verification items, explicitly documented at `README.md:189`; static review found no new code regression.
- abort/timeout, split summaries, empty-summary rejection, local install guidance, privacy disclosure, and Pi handoff correlation were outside this narrow correction or unchanged; no new verified regression was found.

## verification

static evidence only. no source, tests, docs, package state, git state, commits, pushes, agents, or broad tests were changed/run.
