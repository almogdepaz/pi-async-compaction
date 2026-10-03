# astra remote context (experimental)

## stock pi 1.0.0

the `0.1.9-astra.3` prerelease targets stock pi `1.0.0`; it does not patch pi, `node_modules`, auth storage, or the native transport. it composes the public `openai-codex` provider under the same id, so pi retains its normal Codex OAuth credential, catalog, and native stream implementations.

select `openai-codex/gpt-6-astra`. Astra starts in **summary** mode by default: normal Pi/background async summary compaction continues unchanged. Set `PI_ASTRA_COMPACTION_MODE=remote` before starting a new session to default Astra to remote mode; set it to `summary` or leave it unset for summary mode. Any other nonempty value is rejected.

Use the per-session command to choose and persist an override:

```text
/astra summary
/astra remote
```

`/astra remote` adds a versioned durable mode override and a remote-window marker. An environment-selected default does not persist an override; restarting an explicitly selected session does not duplicate its choice. Its Astra requests force native SSE and use the public injected `fetch` boundary to revalidate auth/window state before each native retry. Ordinary Codex models and summary-mode Astra requests retain their supplied native transport and options.

`summary` removes the remote wrapper for subsequent requests and returns to normal async summary compaction. If remote requests end with a structured HTTP `429` or `5xx` service response, Astra visibly records the same summary-mode fallback. Authentication/account failures, malformed persisted state or ciphertext, cancellations, redirects, and other HTTP statuses do not fall back.

Remote mode preserves encrypted history/notes replay. `new_context` acknowledges a queued transition; the window becomes durable only at the successful boundary after the tool batch. Explicit rollover retains no conversational tail; automatic rollover retains the safe recent tail, including tool-call/result pairs. Cancellation discards pending transitions. Normal summary compaction is cancelled only for the exact Astra model while remote mode is active.

Eligible terminal generation or history/notes failures record one visible summary-mode transition at a safe boundary. Recovery tools are disabled before the immediate continuation, not only at settlement; discarded or corrupt fallback drafts cannot reopen remote dispatch. Failed notes mutations are not replayed. Later retries, cancellation, or account changes cannot reuse an earlier service status to authorize fallback.

For installation and the distinction from older tags, see the [README prerelease guidance](../README.md#astra-prerelease). The legacy host patch remains in the repository for historical reference but is excluded from this stock package.

## limits and legacy sessions

This is extension-owned behavior, not a global host guard. Disabling/removing the extension or switching providers leaves stock Pi behavior in control. Do not open or migrate sessions containing the old `pi.required-context-handler` marker: they are legacy patched-host sessions and are intentionally not silently adopted by this implementation.

Use a separate model runtime per remote session: same-id provider registration is runtime-global. Shared-runtime requests with the wrong session identity are rejected, not multiplexed. Tool ownership checks use public registration/source metadata; arbitrary same-process extensions are not a security isolation boundary. Later context-hook removal/reordering of retained messages is checked again in the owned provider, but stock has no final mandatory boundary validator against competing extensions.

No live backend entitlement, migration, installation, or credential claim is made here. Recovered history, notes, and images remain untrusted model content.
