import { EXTENSION_NAME, InvalidationReason } from "./constants";
import type { RuntimeState } from "./types";

export function createRuntimeState(): RuntimeState {
	return {
		status: "idle",
		jobId: undefined,
		ready: undefined,
		reason: undefined,
		error: undefined,
		abortController: undefined,
		jobCounter: 0,
		lastHandedOffJobId: undefined,
		autoResumeAfterCompactionJobId: undefined,
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
	state.lastHandedOffJobId = undefined;
	state.autoResumeAfterCompactionJobId = undefined;
}

export function getAbortInvalidationReason(timedOut: boolean): InvalidationReason {
	return timedOut ? InvalidationReason.TIMEOUT : InvalidationReason.CANCELLED;
}
