import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME, InvalidationReason, SUMMARY_PROMPT_VERSION } from "./constants";
import { prepareAsyncCompaction } from "./preparation";
import { getAbortInvalidationReason, markStale, nextJobId } from "./runtime-state";
import type { AsyncCompactionDetails, LocalCompactionPreparation, ReadyJob, ResolvedCompactionSettings, RuntimeState, Snapshot } from "./types";
import { estimateAfterApply } from "./validation";
import {
	getCompactionSettings,
	getStartRatio,
	getThinkingLevel,
	getTimeoutMs,
	isEnabled,
	modelKey,
	settingsKey,
} from "./utils";

function shouldReplaceReadyJob(ready: ReadyJob, ctx: ExtensionContext, settings: ResolvedCompactionSettings): boolean {
	const currentPath = ctx.sessionManager.getBranch();
	if (ctx.sessionManager.getLeafId() === ready.snapshotLeafId) {
		return false;
	}
	if (ready.sessionId !== ctx.sessionManager.getSessionId()) {
		return true;
	}
	if (!ctx.model || ready.modelKey !== modelKey(ctx.model)) {
		return true;
	}
	if (ready.thinkingLevel !== getThinkingLevel(currentPath)) {
		return true;
	}
	if (ready.settingsKey !== settingsKey(settings)) {
		return true;
	}

	const maxAfter = (ctx.model.contextWindow ?? 0) - settings.reserveTokens;
	return maxAfter > 0 && estimateAfterApply(ready, currentPath) > maxAfter;
}

async function buildAsyncCompactionResult(
	preparation: LocalCompactionPreparation,
	model: Model<Api>,
	ctx: ExtensionContext,
	thinkingLevel: ThinkingLevel,
	signal: AbortSignal,
): Promise<CompactionResult> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${model.provider}`);
	}

	return compact(preparation, model, auth.apiKey, auth.headers, undefined, signal, thinkingLevel);
}

export interface StartAsyncJobDependencies {
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
	readonly triggerCompaction: (ctx: ExtensionContext, onError: (error: Error) => void) => void;
}

export interface StartAsyncJobOptions {
	readonly force: boolean;
	readonly timeoutMs?: number;
}

const defaultStartAsyncJobDependencies: StartAsyncJobDependencies = {
	buildAsyncCompactionResult,
	getCompactionSettings,
	getStartRatio,
	getTimeoutMs,
	isEnabled,
	setCliStatus: (ctx, text) => {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, text);
	},
	triggerCompaction: (ctx, onError) => ctx.compact({ onError }),
};

export function startAsyncJob(ctx: ExtensionContext, state: RuntimeState, options: StartAsyncJobOptions = { force: false, timeoutMs: undefined }): void {
	startAsyncJobWithDeps(ctx, state, defaultStartAsyncJobDependencies, options);
}

function recordApplyError(state: RuntimeState, jobId: string, error: Error): void {
	if (state.status !== "ready" || state.jobId !== jobId) return;
	state.status = "failed";
	state.ready = undefined;
	state.reason = InvalidationReason.FAILED;
	state.error = `apply failed: ${error.message}`;
}

export function startAsyncJobWithDeps(
	ctx: ExtensionContext,
	state: RuntimeState,
	deps: StartAsyncJobDependencies,
	options: StartAsyncJobOptions = { force: false, timeoutMs: undefined },
): void {
	if (!deps.isEnabled() || !ctx.model) return;

	const settings = deps.getCompactionSettings(ctx);
	if (!settings.enabled) return;

	if (!options.force) {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

		const startThreshold = Math.floor(usage.contextWindow * deps.getStartRatio());
		const forceThreshold = usage.contextWindow - settings.reserveTokens;
		if (usage.tokens <= startThreshold || usage.tokens > forceThreshold) return;
	}

	if (state.status === "pending") return;
	if (state.status === "ready" && state.ready && !shouldReplaceReadyJob(state.ready, ctx, settings)) {
		if (options.force) {
			const readyJobId = state.ready.jobId;
			deps.triggerCompaction(ctx, (error) => recordApplyError(state, readyJobId, error));
		}
		return;
	}
	if (state.status === "ready") {
		markStale(state, InvalidationReason.SUPERSEDED);
	}

	const branch = ctx.sessionManager.getBranch();
	const preparation = prepareAsyncCompaction(branch, settings);
	if (!preparation) return;

	const snapshotLeafId = branch[branch.length - 1]?.id;
	if (!snapshotLeafId) return;

	const jobId = nextJobId(state);
	state.abortController?.abort();
	const abortController = new AbortController();
	state.abortController = abortController;

	state.status = "pending";
	state.jobId = jobId;
	state.ready = undefined;
	state.reason = undefined;
	state.error = undefined;
	deps.setCliStatus(ctx, "async_compaction ...");

	const model = ctx.model;
	const thinkingLevel = getThinkingLevel(branch);
	const snapshot: Snapshot = {
		jobId,
		sessionId: ctx.sessionManager.getSessionId(),
		snapshotLeafId,
		firstKeptEntryId: preparation.firstKeptEntryId,
		modelKey: modelKey(model),
		thinkingLevel,
		settingsKey: settingsKey(settings),
		promptVersion: SUMMARY_PROMPT_VERSION,
	};

	const timeoutMs = options.timeoutMs ?? deps.getTimeoutMs();
	let timedOut = false;
	const timeout =
		timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				abortController.abort();
			}, timeoutMs)
			: undefined;

	void deps.buildAsyncCompactionResult(preparation, model, ctx, thinkingLevel, abortController.signal)
		.then((result) => {
			if (timeout) clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			if (abortController.signal.aborted) {
				markStale(state, getAbortInvalidationReason(timedOut));
				deps.setCliStatus(ctx, undefined);
				return;
			}
			if (!result.summary.trim()) {
				markStale(state, InvalidationReason.FAILED);
				deps.setCliStatus(ctx, undefined);
				return;
			}

			const piDetails =
				result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};

			state.abortController = undefined;
			state.status = "ready";
			state.ready = {
				...snapshot,
				result: {
					...result,
					details: {
						...piDetails,
						asyncPrefixCompaction: {
							jobId,
							snapshotLeafId,
							modelKey: snapshot.modelKey,
							thinkingLevel,
							settingsKey: snapshot.settingsKey,
							promptVersion: SUMMARY_PROMPT_VERSION,
						},
					} satisfies AsyncCompactionDetails,
				},
			};
			deps.setCliStatus(ctx, undefined);
			deps.triggerCompaction(ctx, (error) => recordApplyError(state, jobId, error));
		})
		.catch((error: unknown) => {
			if (timeout) clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			state.abortController = undefined;
			if (abortController.signal.aborted) {
				state.status = "stale";
				state.reason = getAbortInvalidationReason(timedOut);
				state.error = undefined;
				deps.setCliStatus(ctx, undefined);
				return;
			}
			state.status = "failed";
			state.reason = InvalidationReason.FAILED;
			state.error = error instanceof Error ? error.message : String(error);
			deps.setCliStatus(ctx, undefined);
		});
}
