# full project review

goal: produce an evidence-backed review of the current `main` project state covering architecture, correctness, security, maintainability, testing, performance, packaging, documentation, and developer experience.

success criteria:
- inspect all tracked production, test, package, and documentation surfaces relevant to runtime behavior
- run the repository's normal verification commands and record exact results
- distinguish verified findings from limitations and speculative opportunities
- prioritize problems by severity, confidence, impact, and remediation effort
- publish the consolidated review at `.plans/001-project-review.md`

non-goals:
- modify production code, tests, package metadata, or existing documentation
- fix findings
- commit, push, merge, or alter existing uncommitted work
- audit dependency internals beyond their exposed contracts and installed metadata

## 1. Map architecture and invariants

Load EDC routing/context, repository history, package metadata, design documents, and source boundaries.

## 2. Inspect implementation and tests

Review the full tracked source and test corpus for correctness, lifecycle safety, maintainability, performance, and test value.

## 3. Verify project health

Run the documented test, typecheck, syntax-check, and package-preview commands; record exact outcomes and skipped/optional coverage.

## 4. Perform independent review

Use one persistent read-only Terra reviewer session for adversarial security, delivery/architecture, quality/test-value, and antipattern analysis.

## 5. Consolidate findings

Write pros, cons, prioritized problems, concrete improvements, verification evidence, limitations, and an implementation sequence to `.plans/001-project-review.md`.
