/*
 * Adapted from @howaboua/pi-codex-conversion at 7021ae48e8efe36a3becc5830d529696ff798e5e.
 * Copyright (c) 2026 Igor Warzocha. MIT License; see ATTRIBUTION.md.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HistoryAction, NotesAction } from "./contract";
import { isAstraRemoteModel } from "./activation";
import { resolveAstraCodexAuth } from "./auth";
import type { AstraWindowIdentity } from "./provider";

const CODEX_ORIGIN = "https://chatgpt.com";
const CODEX_BASE_PATH = "/backend-api/codex/";
const BACKEND_TIMEOUT_MS = 35_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const HISTORY_ENDPOINTS: Record<HistoryAction, string> = {
	list_windows: "alpha/history/v2/list_windows",
	list_items: "alpha/history/v2/list_items",
	read_item: "alpha/history/v2/read_item",
	search_contents: "alpha/history/v2/search_contents",
};

const NOTES_ENDPOINTS: Record<NotesAction, string> = {
	list_files_by_prefix: "alpha/notes/v2/list_files_by_prefix",
	read_file: "alpha/notes/v2/read_file",
	search_contents: "alpha/notes/v2/search_contents",
	append_to_file: "alpha/notes/v2/append_to_file",
	write_file: "alpha/notes/v2/write_file",
};

export interface AstraImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
	readonly detail?: "auto" | "high" | "original";
}

export interface AstraBackendResult {
	readonly output: Record<string, unknown>;
	readonly images: readonly AstraImage[];
}

function endpointUrl(endpoint: string): URL {
	const url = new URL(endpoint, `${CODEX_ORIGIN}${CODEX_BASE_PATH}`);
	if (url.origin !== CODEX_ORIGIN || !url.pathname.startsWith(CODEX_BASE_PATH)) {
		throw new Error("Astra endpoint is outside the approved Codex origin");
	}
	return url;
}

function isEncryptedEndpoint(endpoint: string): boolean {
	return endpoint.endsWith("search_contents") || endpoint.endsWith("append_to_file") || endpoint.endsWith("write_file");
}

async function readResponseBody(response: Response): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
		throw new Error("History and notes backend response exceeds the local size limit");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("History and notes backend response exceeds the local size limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(output);
}

function isCanonicalBase64(value: string): boolean {
	if (value === "" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
	return Buffer.from(value, "base64").toString("base64") === value;
}

function parseImages(value: unknown): readonly AstraImage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_IMAGES) {
		throw new Error("History backend returned invalid image content");
	}
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("History backend returned invalid image content");
		}
		const image = item as Record<string, unknown>;
		if (
			typeof image["data"] !== "string" ||
			Buffer.byteLength(image["data"], "utf8") > MAX_IMAGE_BASE64_BYTES ||
			typeof image["mime_type"] !== "string" ||
			!ALLOWED_IMAGE_MIME_TYPES.has(image["mime_type"]) ||
			!isCanonicalBase64(image["data"])
		) {
			throw new Error("History backend returned invalid image content");
		}
		const detail = image["detail"];
		if (detail !== undefined && detail !== null && detail !== "auto" && detail !== "high" && detail !== "original") {
			throw new Error("History backend returned invalid image detail");
		}
		return {
			type: "image" as const,
			data: image["data"],
			mimeType: image["mime_type"],
			...(detail ? { detail } : {}),
		};
	});
}

export async function callAstraBackend(
	ctx: ExtensionContext,
	endpoint: string,
	arguments_: Record<string, unknown>,
	signal: AbortSignal | undefined,
	truncation: { readonly mode: "bytes" | "tokens"; readonly limit: number },
	getExpectedWindow: () => AstraWindowIdentity | undefined,
): Promise<AstraBackendResult> {
	const model = ctx.model;
	const sessionId = ctx.sessionManager.getSessionId();
	const leafId = ctx.sessionManager.getLeafId();
	if (!isAstraRemoteModel(model)) {
		throw new Error("Astra remote context requires openai-codex/gpt-6-astra");
	}
	const expectedWindow = getExpectedWindow();
	if (!expectedWindow || expectedWindow.sessionId !== sessionId) {
		throw new Error("Astra remote context is missing compatible persisted window state");
	}
	const { accountId, authorization } = await resolveAstraCodexAuth(ctx);
	signal?.throwIfAborted();
	if (
		ctx.sessionManager.getSessionId() !== sessionId ||
		ctx.sessionManager.getLeafId() !== leafId ||
		!isAstraRemoteModel(ctx.model) ||
		ctx.model?.id !== model.id
	) {
		throw new Error("Astra remote context changed while authentication was resolving");
	}
	const currentWindow = getExpectedWindow();
	if (
		!currentWindow ||
		currentWindow.currentWindowId !== expectedWindow.currentWindowId ||
		currentWindow.windowNumber !== expectedWindow.windowNumber ||
		currentWindow.accountId !== expectedWindow.accountId
	) {
		throw new Error("Astra remote context changed while authentication was resolving");
	}
	if (accountId !== expectedWindow.accountId) {
		throw new Error("Astra remote context cannot continue with a different Codex account");
	}
	const headers = new Headers({
		authorization,
		"chatgpt-account-id": accountId,
		"content-type": "application/json",
	});
	headers.set("x-openai-tool-output-truncation-policy", JSON.stringify(truncation));
	if (isEncryptedEndpoint(endpoint)) headers.set("x-openai-encrypted-tool-arguments", "true");
	const timeout = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
	const response = await fetch(endpointUrl(endpoint), {
		method: "POST",
		headers,
		redirect: "error",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		body: JSON.stringify({
			...arguments_,
			context: {
				session_id: sessionId,
				current_agent_name: "/root",
			},
		}),
	});
	if (!response.ok) throw new Error(`History and notes backend failed (${response.status})`);
	const body = await readResponseBody(response);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("History and notes backend returned invalid data");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("History and notes backend returned invalid data");
	}
	const output = { ...(parsed as Record<string, unknown>) };
	if (Object.hasOwn(output, "encrypted_output") && (typeof output["encrypted_output"] !== "string" || output["encrypted_output"] === "")) {
		throw new Error("History and notes backend returned invalid encrypted output");
	}
	const images = parseImages(output["images"]);
	delete output["images"];
	return { output, images };
}

export const ASTRA_HISTORY_ENDPOINTS = HISTORY_ENDPOINTS;
export const ASTRA_NOTES_ENDPOINTS = NOTES_ENDPOINTS;
