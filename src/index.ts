import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME, InvalidationReason } from "./constants";
import { startAsyncJob } from "./job";
export { prepareAsyncCompaction } from "./preparation";
import { createRuntimeState, formatRuntimeStatus, markStale } from "./runtime-state";
export { validateReadyJob } from "./validation";
import { getAsyncCompactionMarker, getStartRatio, getTimeoutMs, isEnabled } from "./utils";
import { validateReadyJob } from "./validation";

export default function asyncPrefixCompaction(pi: ExtensionAPI) {
	const state = createRuntimeState();

	function clearCliStatus(ctx: { readonly hasUI: boolean; readonly ui: { readonly setStatus: (key: string, text: string | undefined) => void } }): void {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, undefined);
	}

	function showStatus(ctx: ExtensionCommandContext): void {
		const statusText = formatRuntimeStatus(state, {
			enabled: isEnabled(),
			startRatio: getStartRatio(),
			timeoutMs: getTimeoutMs(),
		});
		if (ctx.hasUI) {
			ctx.ui.notify(statusText, "info");
		} else {
			console.log(statusText);
		}
	}

	pi.on("turn_end", (_event, ctx) => {
		startAsyncJob(ctx, state);
	});

	pi.on("model_select", (_event, ctx) => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.MODEL_CHANGED);
			clearCliStatus(ctx);
		}
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.THINKING_CHANGED);
			clearCliStatus(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		if (state.status === "pending" || state.status === "ready") {
			markStale(state, InvalidationReason.SNAPSHOT_LEAF_MISSING);
			clearCliStatus(ctx);
		}
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
		clearCliStatus(ctx);
		return { compaction: ready.result };
	});

	pi.on("session_compact", (event, ctx) => {
		const marker = event.fromExtension ? getAsyncCompactionMarker(event.compactionEntry.details) : undefined;
		if (!marker) return;

		state.lastAppliedJobId = marker.jobId;
		if (ctx.hasUI) {
			const ui = ctx.ui;
			setTimeout(() => ui.notify("Applied ready async prefix compaction", "info"), 0);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		markStale(state, InvalidationReason.CANCELLED);
		clearCliStatus(ctx);
	});

	pi.registerCommand("async-compact-now", {
		description: "Start async prefix compaction now",
		handler: async (_args, ctx) => {
			startAsyncJob(ctx, state, { force: true });
		},
	});

	pi.registerCommand("async-compact-status", {
		description: "Show async prefix compaction status",
		handler: async (_args, ctx) => {
			showStatus(ctx);
		},
	});
}
