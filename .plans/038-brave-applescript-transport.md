# 038 Brave AppleScript transport

status: implemented; live authentication and completion verified

## goal
replace Playwright-launched ChatGPT automation with the previously proven normal-Brave AppleScript path on this machine.

## evidence
local Pi history from 2026-08-17 shows `osascript` successfully opened `chatgpt.com` in the existing Brave profile, executed page JavaScript, filled `#prompt-textarea` with 1,828 characters, clicked `Send prompt`, and observed generation start. Current Playwright/profile and CDP approaches repeatedly encounter Cloudflare or attachment failures.

## scope
- invoke `/usr/bin/osascript` with argv/stdin; never interpolate prompt or page output into AppleScript source.
- create one ChatGPT tab at the direct target URL and retain that tab reference inside one AppleScript process through authentication, completion, and cleanup; never rediscover it across subprocesses.
- explicit `/chatgpt-web-login` opens/focuses a ChatGPT tab and waits for positive structured `/api/auth/session` data.
- ordinary compaction opens a fresh temporary chat, validates exact `https://chatgpt.com` origin and structured auth, fills/sends the prompt through page-local JavaScript, waits for stable complete output, and converts response-local HTML to Markdown.
- retain a versioned non-secret readiness marker so only explicit login authorizes later Brave invocation; remove the persistent automation profile itself.
- no clipboard, Playwright launch, CDP, provider fallback, or anti-bot bypass.
- serialize Brave operations in-process and keep existing timeout/abort semantics.
- remove Playwright dependency if unused after migration.
- update docs and deterministic tests around the subprocess boundary.

## success criteria
- no separate Chrome/Brave automation profile is launched.
- normal Brave account authentication is reused.
- prompts are base64-encoded into private temporary JavaScript files, never interpolated into AppleScript or process arguments; rendered browser results return base64-encoded.
- auth/origin checks occur before prompt submission.
- created tab is closed without touching unrelated tabs.
- abort first signals the owning AppleScript through a private cancellation file so it can close its tab, then escalates process termination only if needed.
- focused tests, typecheck/check, one final full suite, local installation remains valid.
