import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type AstraModelIdentity = Pick<Model<any>, "provider" | "id" | "api" | "baseUrl">;

export const ASTRA_PROVIDER_ID = "openai-codex";
export const ASTRA_MODEL_ID = "gpt-6-astra";
export const ASTRA_API_ID = "openai-codex-responses";
export const REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE = "pi.required-context-handler";
export const ASTRA_MODE_ENTRY_TYPE = "astra-remote-context-mode";

export type AstraMode = "summary" | "remote";
export const ASTRA_MODE_PROTOCOL = 1;

/** The environment uses the same vocabulary as `/astra summary|remote`. */
export function getAstraDefaultMode(environment: NodeJS.ProcessEnv = process.env): AstraMode {
	const configured = environment.PI_ASTRA_COMPACTION_MODE;
	if (configured === undefined || configured === "") return "summary";
	if (isAstraMode(configured)) return configured;
	throw new Error(`unsupported PI_ASTRA_COMPACTION_MODE: ${configured}; expected summary or remote`);
}

function isAstraMode(value: unknown): value is AstraMode {
	return value === "summary" || value === "remote";
}

/** The latest valid explicit session mode overrides the configured default. */
export function getPersistedAstraMode(entries: readonly SessionEntry[]): AstraMode | undefined {
	let mode: AstraMode | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ASTRA_MODE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (
			!data ||
			typeof data !== "object" ||
			(data as { readonly protocol?: unknown }).protocol !== ASTRA_MODE_PROTOCOL ||
			!isAstraMode((data as { readonly mode?: unknown }).mode)
		) {
			throw new Error("Astra remote context has malformed persisted Astra mode");
		}
		mode = (data as { readonly mode: AstraMode }).mode;
	}
	return mode;
}

export function getAstraMode(entries: readonly SessionEntry[], environment: NodeJS.ProcessEnv = process.env): AstraMode {
	return getPersistedAstraMode(entries) ?? getAstraDefaultMode(environment);
}

export function isAstraRemoteMode(entries: readonly SessionEntry[], environment: NodeJS.ProcessEnv = process.env): boolean {
	return getAstraMode(entries, environment) === "remote";
}

/** The remote protocol is available only to Pi's exact bundled subscription model. */
export function isAstraRemoteModel(model: AstraModelIdentity | undefined): model is AstraModelIdentity {
	if (
		!model ||
		model.provider !== ASTRA_PROVIDER_ID ||
		model.id !== ASTRA_MODEL_ID ||
		model.api !== ASTRA_API_ID
	) {
		return false;
	}
	const baseUrl = new URL(model.baseUrl ?? "https://chatgpt.com/backend-api");
	return baseUrl.origin === "https://chatgpt.com" && baseUrl.pathname.replace(/\/+$/, "") === "/backend-api";
}

/** A persisted requirement is the durable ownership boundary, even after a model switch. */
export function isAstraRemoteContextRequired(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) => entry.type === "custom" && entry.customType === REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE,
	);
}
