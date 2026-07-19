import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncCompactionAdapter } from "./adapter";
import { APPLY_RETRY_DELAY_MS, APPLY_RETRY_LIMIT, EXTENSION_NAME, InvalidationReason } from "./constants";
import { applyReadyCompaction, startAsyncJob } from "./job";
import type { StartAsyncJobOutcome } from "./job";
import { createRuntimeState, markStale } from "./runtime-state";
import type { RuntimeState } from "./types";
import { getAsyncCompactionMarker } from "./utils";
import { validateReadyJob } from "./validation";

export type {
	AdapterCompactionInput,
	AdapterPrepareInput,
	AdapterRunInput,
	AdapterSnapshotInput,
	AsyncCompactionAdapter,
} from "./adapter";
export type { Snapshot } from "./types";

export interface RegisterAsyncCompactionOptions {
	readonly commandName?: string | false;
	readonly commandDescription?: string;
}

export interface AsyncCompactionCoreDependencies {
	readonly applyReadyCompaction: typeof applyReadyCompaction;
	readonly startAsyncJob: typeof startAsyncJob;
}

const defaultCoreDependencies: AsyncCompactionCoreDependencies = {
	applyReadyCompaction,
	startAsyncJob,
};

const DEFAULT_COMMAND_DESCRIPTION = "Start async compaction now";

function eraseAdapter<TPrepared, TResult>(
	adapter: AsyncCompactionAdapter<TPrepared, TResult>,
): AsyncCompactionAdapter<unknown, unknown> {
	return adapter as unknown as AsyncCompactionAdapter<unknown, unknown>;
}

function clearCliStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, undefined);
}

function formatManualStartOutcome(outcome: StartAsyncJobOutcome): string | undefined {
	if (outcome === "started" || outcome === "ready_reused") return undefined;
	const reasonByOutcome: Record<Exclude<StartAsyncJobOutcome, "started" | "ready_reused">, string> = {
		already_pending: "job already pending",
		disabled: "disabled",
		model_missing: "model unavailable",
		settings_disabled: "Pi compaction disabled",
		context_unknown: "context usage unknown",
		start_window_empty: "start window empty",
		below_threshold: "below threshold",
		above_force_threshold: "past compaction threshold",
		nothing_to_compact: "nothing to compact",
	};
	return `async compaction not started: ${reasonByOutcome[outcome]}`;
}

function collapseCompactionRender(ctx: ExtensionContext): void {
	// Pi renders compaction summaries with the global tool-output expansion state.
	if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
}

function invalidateActiveJob(ctx: ExtensionContext, state: RuntimeState, reason: InvalidationReason): void {
	if (state.status !== "pending" && state.status !== "ready") return;
	markStale(state, reason);
	clearCliStatus(ctx);
}

function scheduleReadyCompactionApply(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: AsyncCompactionCoreDependencies,
	expectedJobId?: string,
	retriesRemaining = APPLY_RETRY_LIMIT,
): void {
	const delayMs = expectedJobId ? APPLY_RETRY_DELAY_MS : 0;
	setTimeout(() => {
		const readyJobId = state.ready?.jobId;
		if (state.status !== "ready" || !readyJobId || (expectedJobId && readyJobId !== expectedJobId)) return;
		if (ctx.hasPendingMessages()) return;
		if (ctx.isIdle()) {
			deps.applyReadyCompaction(ctx, state);
			return;
		}
		if (retriesRemaining > 0) {
			scheduleReadyCompactionApply(ctx, state, deps, readyJobId, retriesRemaining - 1);
		}
	}, delayMs);
}

export function registerAsyncCompaction<TPrepared, TResult>(
	pi: ExtensionAPI,
	adapter: AsyncCompactionAdapter<TPrepared, TResult>,
	options: RegisterAsyncCompactionOptions = {},
	injectedDeps: Partial<AsyncCompactionCoreDependencies> = {},
): void {
	const deps = { ...defaultCoreDependencies, ...injectedDeps };
	const state = createRuntimeState();
	const jobAdapter = eraseAdapter(adapter);

	pi.on("turn_end", (_event, ctx) => {
		deps.startAsyncJob(ctx, state, { adapter: jobAdapter, force: false });
	});

	pi.on("agent_end", (_event, ctx) => {
		scheduleReadyCompactionApply(ctx, state, deps);
	});

	pi.on("model_select", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.MODEL_CHANGED);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.THINKING_CHANGED);
	});

	pi.on("session_tree", (_event, ctx) => {
		invalidateActiveJob(ctx, state, InvalidationReason.SNAPSHOT_LEAF_MISSING);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const ready = state.ready;
		if (!ready || state.status !== "ready") {
			if (state.status === "pending") {
				markStale(state, InvalidationReason.SYNC_FALLBACK);
				clearCliStatus(ctx);
			}
			return;
		}

		const invalidReason = validateReadyJob(ready, event, ctx);
		if (invalidReason) {
			markStale(state, invalidReason);
			clearCliStatus(ctx);
			return;
		}

		state.status = "idle";
		state.ready = undefined;
		state.reason = undefined;
		state.lastHandedOffJobId = ready.jobId;
		clearCliStatus(ctx);
		collapseCompactionRender(ctx);
		return { compaction: ready.result };
	});

	pi.on("session_compact", (event, ctx) => {
		const marker = event.fromExtension ? getAsyncCompactionMarker(event.compactionEntry.details) : undefined;
		if (!marker) return;

		if (state.lastHandedOffJobId === marker.jobId) state.lastHandedOffJobId = undefined;
		if (ctx.hasUI) {
			const ui = ctx.ui;
			setTimeout(() => ui.notify("Applied ready async compaction", "info"), 0);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		markStale(state, InvalidationReason.CANCELLED);
		clearCliStatus(ctx);
	});

	if (options.commandName) {
		pi.registerCommand(options.commandName, {
			description: options.commandDescription ?? DEFAULT_COMMAND_DESCRIPTION,
			handler: async (_args, ctx) => {
				const message = formatManualStartOutcome(deps.startAsyncJob(ctx, state, { adapter: jobAdapter, force: true }));
				if (message && ctx.hasUI) ctx.ui.notify(message, "info");
				if (message && !ctx.hasUI) console.log(message);
			},
		});
	}
}
