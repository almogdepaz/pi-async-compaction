import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "./adapter";
import type { AsyncCompactionAdapter } from "./adapter";
import { EXTENSION_NAME, InvalidationReason, SUMMARY_PROMPT_VERSION } from "./constants";
import { getAbortInvalidationReason, markStale, nextJobId } from "./runtime-state";
import type { AsyncCompactionDetails, LocalCompactionPreparation, ReadyJob, ResolvedCompactionSettings, RuntimeState, Snapshot } from "./types";
import { getReadyJobContextInvalidationReason } from "./validation";
import { getCompactionSettings, getStartRatio, getStartWindow, getTimeoutMs, isEnabled } from "./utils";

function shouldReplaceReadyJob(ready: ReadyJob, ctx: ExtensionContext, settings: ResolvedCompactionSettings): boolean {
	return getReadyJobContextInvalidationReason(ready, ctx, settings) !== undefined;
}

function canApplyReadyCompaction(ctx: ExtensionContext): boolean {
	return ctx.isIdle() && !ctx.hasPendingMessages();
}

export async function buildAsyncCompactionResult(
	preparation: LocalCompactionPreparation,
	model: Model<Api>,
	ctx: ExtensionContext,
	thinkingLevel: ThinkingLevel,
	signal: AbortSignal,
	compactFn: typeof compact = compact,
): Promise<CompactionResult> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${model.provider}`);
	}

	return compactFn(preparation, model, auth.apiKey, auth.headers, undefined, signal, thinkingLevel, undefined, auth.env);
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface StartAsyncJobDependencies {
	readonly adapter?: AsyncCompactionAdapter<unknown, unknown>;
	readonly buildAsyncCompactionResult: (
		preparation: LocalCompactionPreparation,
		model: Model<Api>,
		ctx: ExtensionContext,
		thinkingLevel: ThinkingLevel,
		signal: AbortSignal,
	) => Promise<CompactionResult>;
	readonly getCompactionSettings: (ctx: ExtensionContext) => ResolvedCompactionSettings;
	readonly getStartRatio: () => number;
	readonly getTimeoutMs: () => number;
	readonly isEnabled: () => boolean;
	readonly setCliStatus: (ctx: ExtensionContext, text: string | undefined) => void;
	readonly setTimeout: (handler: () => void, timeoutMs: number) => TimeoutHandle;
	readonly clearTimeout: (timeout: TimeoutHandle) => void;
	readonly triggerCompaction: (ctx: ExtensionContext, onError: (error: Error) => void) => void;
}

interface StartAsyncJobOptions {
	readonly adapter?: AsyncCompactionAdapter<unknown, unknown>;
	readonly force: boolean;
	readonly timeoutMs?: number;
}

export type StartAsyncJobOutcome =
	| "started"
	| "already_pending"
	| "ready_reused"
	| "disabled"
	| "model_missing"
	| "settings_disabled"
	| "context_unknown"
	| "start_window_empty"
	| "below_threshold"
	| "above_force_threshold"
	| "nothing_to_compact";

const defaultStartAsyncJobDependencies: StartAsyncJobDependencies = {
	buildAsyncCompactionResult,
	getCompactionSettings,
	getStartRatio,
	getTimeoutMs,
	isEnabled,
	setCliStatus: (ctx, text) => {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, text);
	},
	setTimeout,
	clearTimeout,
	triggerCompaction: (ctx, onError) => ctx.compact({ onError }),
};

export function startAsyncJob(
	ctx: ExtensionContext,
	state: RuntimeState,
	options: StartAsyncJobOptions = { force: false, timeoutMs: undefined },
): StartAsyncJobOutcome {
	return startAsyncJobWithDeps(
		ctx,
		state,
		{ ...defaultStartAsyncJobDependencies, adapter: options.adapter },
		options,
	);
}

export function applyReadyCompaction(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: StartAsyncJobDependencies = defaultStartAsyncJobDependencies,
): boolean {
	if (state.status !== "ready" || !state.ready) return false;
	if (shouldReplaceReadyJob(state.ready, ctx, deps.getCompactionSettings(ctx))) {
		markStale(state, InvalidationReason.SUPERSEDED);
		deps.setCliStatus(ctx, undefined);
		return false;
	}
	if (!canApplyReadyCompaction(ctx)) {
		deps.setCliStatus(ctx, "async_compaction ready");
		return false;
	}
	const readyJobId = state.ready.jobId;
	deps.setCliStatus(ctx, undefined);
	deps.triggerCompaction(ctx, (error) => recordApplyError(state, readyJobId, error));
	return true;
}

function recordApplyError(state: RuntimeState, jobId: string, error: Error): void {
	const isReadyJob = state.status === "ready" && state.jobId === jobId;
	const isHandedOffJob = state.status === "idle" && state.lastHandedOffJobId === jobId;
	if (!isReadyJob && !isHandedOffJob) return;
	state.status = "failed";
	state.ready = undefined;
	state.reason = InvalidationReason.FAILED;
	state.error = `apply failed: ${error.message}`;
	state.lastHandedOffJobId = undefined;
}

function recordBackgroundFailure(state: RuntimeState, error: unknown): void {
	state.status = "failed";
	state.reason = InvalidationReason.FAILED;
	state.error = error instanceof Error ? error.message : String(error);
}

function recordEmptySummaryFailure(state: RuntimeState): void {
	state.abortController = undefined;
	state.status = "failed";
	state.ready = undefined;
	state.reason = InvalidationReason.FAILED;
	state.error = "empty compaction summary";
}

function storeReadyResult(state: RuntimeState, snapshot: Snapshot, result: CompactionResult): void {
	const piDetails = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};

	state.abortController = undefined;
	state.status = "ready";
	state.ready = {
		...snapshot,
		result: {
			...result,
			details: {
				...piDetails,
				asyncPrefixCompaction: {
					jobId: snapshot.jobId,
					snapshotLeafId: snapshot.snapshotLeafId,
					modelKey: snapshot.modelKey,
					thinkingLevel: snapshot.thinkingLevel,
					settingsKey: snapshot.settingsKey,
					promptVersion: SUMMARY_PROMPT_VERSION,
				},
			} satisfies AsyncCompactionDetails,
		},
	};
}

function scheduleTimeout(
	deps: StartAsyncJobDependencies,
	ctx: ExtensionContext,
	state: RuntimeState,
	jobId: string,
	abortController: AbortController,
	timeoutMs: number,
	onTimeout: () => void,
): TimeoutHandle | undefined {
	if (timeoutMs <= 0) return undefined;
	return deps.setTimeout(() => {
		onTimeout();
		abortController.abort();
		if (state.status !== "pending" || state.jobId !== jobId) return;
		markStale(state, InvalidationReason.TIMEOUT);
		deps.setCliStatus(ctx, undefined);
	}, timeoutMs);
}

function getAutomaticStartBlocker(
	ctx: ExtensionContext,
	deps: StartAsyncJobDependencies,
	settings: ResolvedCompactionSettings,
): StartAsyncJobOutcome | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) return "context_unknown";

	// Pi's shouldCompact checks the final trigger threshold; async starts earlier and must keep its own window.
	const startWindow = getStartWindow(usage.contextWindow, deps.getStartRatio(), settings.reserveTokens);
	if (startWindow.kind === "unknown") return "context_unknown";
	if (startWindow.kind === "empty") return "start_window_empty";
	if (usage.tokens <= startWindow.startThreshold) return "below_threshold";
	if (usage.tokens > startWindow.forceThreshold) return "above_force_threshold";
	return undefined;
}

function markPending(state: RuntimeState, jobId: string, abortController: AbortController): void {
	state.abortController?.abort();
	state.abortController = abortController;
	state.status = "pending";
	state.jobId = jobId;
	state.ready = undefined;
	state.reason = undefined;
	state.error = undefined;
	state.lastHandedOffJobId = undefined;
}

function getAdapter(deps: StartAsyncJobDependencies): AsyncCompactionAdapter<unknown, unknown> {
	return deps.adapter ?? createBuiltinPiCompactionAdapter(deps.buildAsyncCompactionResult) as AsyncCompactionAdapter<unknown, unknown>;
}

export function startAsyncJobWithDeps(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: StartAsyncJobDependencies,
	options: StartAsyncJobOptions = { force: false, timeoutMs: undefined },
): StartAsyncJobOutcome {
	if (!deps.isEnabled()) return "disabled";
	if (!ctx.model) return "model_missing";

	const settings = deps.getCompactionSettings(ctx);
	if (!settings.enabled) return "settings_disabled";

	if (!options.force) {
		const blocker = getAutomaticStartBlocker(ctx, deps, settings);
		if (blocker) return blocker;
	}

	if (state.status === "pending") return "already_pending";
	if (state.status === "ready" && state.ready && !shouldReplaceReadyJob(state.ready, ctx, settings)) {
		if (options.force) applyReadyCompaction(ctx, state, deps);
		return "ready_reused";
	}
	if (state.status === "ready") {
		markStale(state, InvalidationReason.SUPERSEDED);
	}

	const adapter = options.adapter ?? getAdapter(deps);
	const prepared = adapter.prepare({ ctx, settings });
	if (!prepared) return "nothing_to_compact";

	const jobId = nextJobId(state);
	const abortController = new AbortController();
	const snapshot = adapter.createSnapshot({ ctx, jobId, prepared, settings });
	markPending(state, jobId, abortController);
	deps.setCliStatus(ctx, "async_compaction ...");

	const timeoutMs = options.timeoutMs ?? deps.getTimeoutMs();
	let timedOut = false;
	const timeout = scheduleTimeout(deps, ctx, state, jobId, abortController, timeoutMs, () => {
		timedOut = true;
	});

	void adapter.run({ ctx, prepared, signal: abortController.signal })
		.then((adapterResult) => {
			if (timeout) deps.clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			if (abortController.signal.aborted) {
				markStale(state, getAbortInvalidationReason(timedOut));
				deps.setCliStatus(ctx, undefined);
				return;
			}

			const result = adapter.toCompaction({ prepared, snapshot, result: adapterResult });
			if (!result.summary.trim()) {
				recordEmptySummaryFailure(state);
				deps.setCliStatus(ctx, undefined);
				return;
			}

			storeReadyResult(state, snapshot, result);
			applyReadyCompaction(ctx, state, deps);
		})
		.catch((error: unknown) => {
			if (timeout) deps.clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			state.abortController = undefined;
			if (abortController.signal.aborted) {
				state.status = "stale";
				state.reason = getAbortInvalidationReason(timedOut);
				state.error = undefined;
				deps.setCliStatus(ctx, undefined);
				return;
			}
			recordBackgroundFailure(state, error);
			deps.setCliStatus(ctx, undefined);
		});
	return "started";
}
