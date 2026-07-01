import { EXTENSION_NAME, InvalidationReason } from "./constants";
import type { RuntimeState } from "./types";

export interface RuntimeStatusOptions {
	readonly enabled: boolean;
	readonly startRatio: number;
	readonly timeoutMs: number;
}

export function createRuntimeState(): RuntimeState {
	return {
		status: "idle",
		jobId: undefined,
		ready: undefined,
		reason: undefined,
		error: undefined,
		abortController: undefined,
		jobCounter: 0,
		lastAppliedJobId: undefined,
	};
}

export function nextJobId(state: RuntimeState): string {
	state.jobCounter++;
	return `${EXTENSION_NAME}-${state.jobCounter}`;
}

export function markStale(state: RuntimeState, reason: InvalidationReason): void {
	state.abortController?.abort();
	state.abortController = undefined;
	state.status = "stale";
	state.ready = undefined;
	state.reason = reason;
}

export function getAbortInvalidationReason(timedOut: boolean): InvalidationReason {
	return timedOut ? InvalidationReason.TIMEOUT : InvalidationReason.CANCELLED;
}

export function formatRuntimeStatus(state: RuntimeState, options: RuntimeStatusOptions): string {
	return [
		`status: ${state.status}`,
		`job: ${state.jobId ?? "none"}`,
		`lastApplied: ${state.lastAppliedJobId ?? "none"}`,
		`reason: ${state.reason ?? "none"}`,
		`error: ${state.error ?? "none"}`,
		`enabled: ${options.enabled}`,
		`startRatio: ${options.startRatio}`,
		`timeoutMs: ${options.timeoutMs}`,
	].join("\n");
}
