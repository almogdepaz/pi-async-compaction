import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { createBuiltinPiCompactionAdapter } from "./adapter";
import type { AsyncCompactionAdapter, BuildAsyncCompactionResult, BuiltinPiPreparedCompaction } from "./adapter";
import { buildChatGptWebCompactionResult } from "./chatgpt-compaction";
import type { ChatGptTransport } from "./chatgpt-types";
import { createChatGptWebTransport } from "./chatgpt-web";
import {
	PROVIDER_SUMMARY_PROMPT_VERSION,
	SELECTABLE_ADAPTER_ID,
	SELECTABLE_ADAPTER_LABEL,
	SUMMARY_PROMPT_VERSION,
} from "./constants";
import { buildAsyncCompactionResult } from "./job";

export type CompactionBackend = "provider" | "web";
export type CompactionMode = "normal" | "async";

export function getCompactionBackend(): CompactionBackend {
	return process.env.PI_ASYNC_PREFIX_COMPACTION_BACKEND === "provider" ? "provider" : "web";
}

export function getCompactionMode(): CompactionMode {
	return process.env.PI_COMPACTION_MODE === "normal" ? "normal" : "async";
}

interface BackendSnapshot {
	readonly backend: CompactionBackend;
	readonly promptVersion: string;
}

export interface BackendPreparedCompaction extends BuiltinPiPreparedCompaction, BackendSnapshot {}

export interface BackendAdapterDependencies {
	readonly buildProviderResult?: BuildAsyncCompactionResult;
	readonly webTransport?: ChatGptTransport;
}

function snapshotBackend(backend: CompactionBackend): BackendSnapshot {
	return {
		backend,
		promptVersion: backend === "provider" ? PROVIDER_SUMMARY_PROMPT_VERSION : SUMMARY_PROMPT_VERSION,
	};
}

/**
 * Uses one stable generic registration identity. Backend and prompt version are
 * snapshotted with preparation so persisted correlation always identifies the work.
 */
export function createBackendCompactionAdapter(
	getBackend: () => CompactionBackend,
	dependencies: BackendAdapterDependencies = {},
): AsyncCompactionAdapter<BackendPreparedCompaction, CompactionResult> {
	const provider = dependencies.buildProviderResult ?? buildAsyncCompactionResult;
	const webTransport = dependencies.webTransport ?? createChatGptWebTransport();
	const base = createBuiltinPiCompactionAdapter(provider, {
		id: SELECTABLE_ADAPTER_ID,
		label: SELECTABLE_ADAPTER_LABEL,
	});

	return {
		id: SELECTABLE_ADAPTER_ID,
		label: SELECTABLE_ADAPTER_LABEL,
		prepare: (input) => {
			const prepared = base.prepare(input);
			return prepared ? { ...prepared, ...snapshotBackend(getBackend()) } : undefined;
		},
		createSnapshot: (input) => ({
			...base.createSnapshot(input),
			promptVersion: input.prepared.promptVersion,
		}),
		run: ({ ctx, prepared, signal }) => prepared.backend === "provider"
			? provider(prepared.preparation, prepared.model, ctx, prepared.thinkingLevel, signal)
			: buildChatGptWebCompactionResult(prepared.preparation, signal, webTransport),
		toCompaction: (input) => base.toCompaction(input),
	};
}
