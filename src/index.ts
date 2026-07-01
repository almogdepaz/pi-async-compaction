import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InvalidationReason } from "./constants";
import { startAsyncJob } from "./job";
export { prepareAsyncCompaction } from "./preparation";
import { createRuntimeState, markStale } from "./runtime-state";
export { validateReadyJob } from "./validation";
import { getStartRatio, getTimeoutMs, isEnabled } from "./utils";
import { validateReadyJob } from "./validation";

export default function asyncPrefixCompaction(pi: ExtensionAPI) {
	const state = createRuntimeState();

	pi.on("turn_end", (_event, ctx) => {
		startAsyncJob(ctx, state);
	});

	pi.on("model_select", () => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.MODEL_CHANGED);
		}
	});

	pi.on("thinking_level_select", () => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.THINKING_CHANGED);
		}
	});

	pi.on("session_tree", () => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.SNAPSHOT_LEAF_MISSING);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const ready = state.ready;
		if (!ready || state.status !== "ready") {
			if (state.status === "pending") {
				markStale(state, InvalidationReason.SYNC_FALLBACK);
			}
			return;
		}

		const invalidReason = validateReadyJob(ready, event, ctx);
		if (invalidReason) {
			markStale(state, invalidReason);
			return;
		}

		state.status = "idle";
		state.ready = undefined;
		state.reason = undefined;
		return { compaction: ready.result };
	});

	pi.on("session_compact", (event, ctx) => {
		if (event.fromExtension && ctx.hasUI) {
			ctx.ui.notify("Applied ready async prefix compaction", "info");
		}
	});

	pi.on("session_shutdown", () => {
		markStale(state, InvalidationReason.CANCELLED);
	});

	pi.registerCommand("async-compact-status", {
		description: "Show async prefix compaction status",
		handler: async (_args, ctx) => {
			const lines = [
				`status: ${state.status}`,
				`job: ${state.jobId ?? "none"}`,
				`reason: ${state.reason ?? "none"}`,
				`error: ${state.error ?? "none"}`,
				`enabled: ${isEnabled()}`,
				`startRatio: ${getStartRatio()}`,
				`timeoutMs: ${getTimeoutMs()}`,
			];
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
