import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type AstraModelIdentity = Pick<Model<any>, "provider" | "id" | "api" | "baseUrl">;

export const ASTRA_PROVIDER_ID = "openai-codex";
export const ASTRA_MODEL_ID = "gpt-6-astra";
export const ASTRA_API_ID = "openai-codex-responses";
export const REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE = "pi.required-context-handler";

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
