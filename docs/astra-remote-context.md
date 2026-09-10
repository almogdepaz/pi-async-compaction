# astra remote context (experimental)

## prerelease compatibility

This document describes the `0.1.9-astra.0` prerelease, not published `0.1.8`. It requires the exact patched Pi `0.85.1` source contract based at `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`; matching `0.85.1` semver alone is insufficient. Do not use it with unpatched, older, or future Pi hosts.

The package loads both its normal async compactor and the Astra entrypoint. Astra remote context activates **only** when the selected model is exactly `openai-codex/gpt-6-astra` from Pi's built-in Codex subscription provider. There is no Astra environment flag and `PI_ASYNC_PREFIX_COMPACTION=0` must not be set: ordinary models keep the default async compactor.

## exact host build and isolated activation

Do not apply the patch to another Pi revision. These commands clone the tagged extension, check out the exact host base, verify and apply the shipped patch, build every local Pi workspace, and run the patched CLI with an isolated configuration. Your normal `pi` command and configuration remain unchanged.

```bash
git clone https://github.com/almogdepaz/pi-async-compaction.git
cd pi-async-compaction
git checkout --detach v0.1.9-astra.0
extension_repo="$PWD"

cd ..
git clone https://github.com/earendil-works/pi.git pi-astra-host
cd pi-astra-host
git checkout --detach 9767ba275f3e9a5ee0f5c5342249b629ab1b2282
git apply --check "$extension_repo/patches/pi-astra-required-context-handler-9767ba275f3e.patch"
git apply "$extension_repo/patches/pi-astra-required-context-handler-9767ba275f3e.patch"
git diff --check
npm ci --ignore-scripts
npm run build

export PI_CODING_AGENT_DIR="$HOME/.pi/astra-0.1.9-astra.0"
node packages/coding-agent/dist/cli.js install git:github.com/almogdepaz/pi-async-compaction@v0.1.9-astra.0
node packages/coding-agent/dist/cli.js
```

Select `openai-codex/gpt-6-astra` in a new or ordinary session. Keep using that explicit CLI path and `PI_CODING_AGENT_DIR` for Astra sessions. Removing the isolated configuration directory removes its settings and package installation; no global Pi link is replaced.

On selection, existing ordinary context remains present and Astra adds its durable remote-window boundary. Thereafter the default async compactor is excluded for that persisted session; Astra supplies no-summary rollover instead. Selecting an ordinary or API-key model after that boundary fails closed before provider dispatch. Start a new ordinary session rather than downgrading a protected Astra session.

Astra preserves Pi's native Codex transport and both public stream profiles. Host OAuth derives the account from the bearer, including legacy credentials without stored account metadata, and rejects conflicting stored metadata. Activation persists that account binding. Each generation attempt rechecks the live account and request identity; same-account bearer refresh is allowed, while account swaps are rejected. It sends history/notes credentials only to `https://chatgpt.com/backend-api/codex/alpha/...`, rejects redirects, and does not implement login, refresh, credential storage, model discovery, provider fallback, or a model switch.

The entrypoint requires the accompanying Pi core patch at `patches/pi-astra-required-context-handler-9767ba275f3e.patch`, pinned to Pi core `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` (the isolated host is 0.85.1). Affected sessions persist a required handler marker and patched Pi rejects dispatch or compaction when this entrypoint is missing, disabled, reloaded without its handler, malformed, or version-incompatible. Root development dependencies remain 0.84.4 for typechecking; they do not contain the Astra model and are not evidence of runnable Astra compatibility. Older Pi versions ignore the marker: loading raw JSONL there is unsupported and is not forward-security.

Selecting Astra requests backend ingestion. This does **not** prove account eligibility: the private service can reject any operation, and no live entitlement, ingestion, rollover, restart, fork, tree, or recall claim is made here. Fork and tree navigation are blocked once a required remote session is active; local session ids are not presented as remote history clones. Account changes are rejected; stop and start a new remote session instead.

Context hooks may add guidance, but cannot delete, reorder, or replace retained task/tool messages. Final payload hooks cannot rewrite the protected native input or model. Compaction validates the original retained-tail boundary before committing; cancelled preparation publishes no window, and duplicate pending `new_context` calls are rejected. Reload restores the host provider before rewrapping it.

A reply without `encrypted_output` is a valid plaintext receipt. A present empty or malformed ciphertext is rejected. Images require supported MIME types and canonical base64 within the response/image bounds; this is not a full image-decoder security audit.

Recovered notes/history/images are untrusted model content. Remote replies are bounded before JSON parsing; ciphertext is rejected rather than truncated. History and note write failures are surfaced as failures, not silently routed to local storage. The active Pi JSONL remains canonical; `new_context` inserts a persistent window marker and projects from that marker without a plaintext fallback summary.

Source attribution: [`src/astra/ATTRIBUTION.md`](../src/astra/ATTRIBUTION.md).
