import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { InvalidationReason, SUMMARY_PROMPT_VERSION } from "./constants";
import { prepareAsyncCompaction } from "./preparation";
import { markStale, nextJobId } from "./runtime-state";
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

export function startAsyncJob(ctx: ExtensionContext, state: RuntimeState): void {
	if (!isEnabled() || !ctx.model) return;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;

	const settings = getCompactionSettings(ctx);
	if (!settings.enabled) return;

	const startThreshold = Math.floor(usage.contextWindow * getStartRatio());
	const forceThreshold = usage.contextWindow - settings.reserveTokens;
	if (usage.tokens <= startThreshold || usage.tokens > forceThreshold) return;

	if (state.status === "pending") return;
	if (state.status === "ready" && state.ready && !shouldReplaceReadyJob(state.ready, ctx, settings)) return;
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

	const timeoutMs = getTimeoutMs();
	const timeout = timeoutMs > 0 ? setTimeout(() => abortController.abort(), timeoutMs) : undefined;

	void buildAsyncCompactionResult(preparation, model, ctx, thinkingLevel, abortController.signal)
		.then((result) => {
			if (timeout) clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			if (abortController.signal.aborted) {
				markStale(state, InvalidationReason.CANCELLED);
				return;
			}
			if (!result.summary.trim()) {
				markStale(state, InvalidationReason.FAILED);
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
		})
		.catch((error: unknown) => {
			if (timeout) clearTimeout(timeout);
			if (state.status !== "pending" || state.jobId !== jobId) return;
			state.abortController = undefined;
			if (abortController.signal.aborted) {
				state.status = "stale";
				state.reason = InvalidationReason.CANCELLED;
				state.error = undefined;
				return;
			}
			state.status = "failed";
			state.reason = InvalidationReason.FAILED;
			state.error = error instanceof Error ? error.message : String(error);
		});
}
