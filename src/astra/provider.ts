/*
 * Adapted from @howaboua/pi-codex-conversion at 7021ae48e8efe36a3becc5830d529696ff798e5e.
 * Copyright (c) 2026 Igor Warzocha. MIT License; see ATTRIBUTION.md.
 */

import { isDeepStrictEqual } from "node:util";
import {
	createAssistantMessageEventStream,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { ASTRA_MODEL_ID } from "./activation";
import type { AstraCodexAuth } from "./auth";
import { createReservedContextNamespaces, isHistoryAction, isNotesAction } from "./contract";

const APPROVED_CODEX_ORIGIN = "https://chatgpt.com";
const ASTRA_WINDOW_MESSAGE_TYPE = "astra-remote-context-window";

export interface AstraWindowIdentity {
	readonly sessionId: string;
	readonly firstWindowId: string;
	readonly currentWindowId: string;
	readonly previousWindowId?: string;
	readonly windowNumber: number;
	readonly accountId: string;
}

export type AstraWindowLookup =
	| { readonly kind: "ordinary" }
	| { readonly kind: "required"; readonly window: AstraWindowIdentity; readonly leafId: string | null }
	| { readonly kind: "invalid"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertCodexModel(model: Model<any>): void {
	const baseUrl = new URL(model.baseUrl ?? `${APPROVED_CODEX_ORIGIN}/backend-api`);
	if (
		model.provider !== "openai-codex" ||
		model.id !== ASTRA_MODEL_ID ||
		model.api !== "openai-codex-responses" ||
		baseUrl.origin !== APPROVED_CODEX_ORIGIN ||
		baseUrl.pathname.replace(/\/+$/, "") !== "/backend-api"
	) {
		throw new Error("Astra remote context requires the built-in OpenAI Codex subscription provider");
	}
}

function rewriteReservedTools(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const namespaces = createReservedContextNamespaces();
	const replace = (tools: unknown): unknown => {
		if (!Array.isArray(tools)) return tools;
		return tools.map((tool) => {
			if (!isRecord(tool) || (tool["name"] !== "history" && tool["name"] !== "notes")) return tool;
			return namespaces.find((namespace) => namespace.name === tool["name"]) ?? tool;
		});
	};
	const tools = replace(payload["tools"]);
	const input = Array.isArray(payload["input"])
		? payload["input"].map((item) => isRecord(item) && Array.isArray(item["tools"])
			? { ...item, tools: replace(item["tools"]) }
			: item)
		: payload["input"];
	return { ...payload, tools, input };
}

interface AstraRequestMetadata {
	readonly session_id: string;
	readonly thread_id: string;
	readonly agent_name: "/root";
	readonly window_id: string;
	readonly window_number: number;
	readonly context_window_id: string;
	readonly request_kind: "turn";
	readonly history_ingest_requested: true;
}

function withWindowMetadata(payload: unknown, metadata: AstraRequestMetadata): unknown {
	if (!isRecord(payload)) throw new Error("Astra remote context requires a structured native request payload");
	const clientMetadata = payload["client_metadata"];
	if (clientMetadata !== undefined && !isRecord(clientMetadata)) {
		throw new Error("Astra remote context rejected malformed client_metadata");
	}
	return {
		...payload,
		client_metadata: {
			...clientMetadata,
			"x-codex-window-id": metadata.window_id,
			"x-codex-turn-metadata": JSON.stringify(metadata),
		},
	};
}

function assertWindowAccount(headers: SimpleStreamOptions["headers"], window: AstraWindowIdentity): void {
	const accountId = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1];
	if (typeof accountId !== "string" || accountId === "") {
		throw new Error("Astra remote context requires validated Codex account metadata");
	}
	if (accountId !== window.accountId) {
		throw new Error("Astra remote context cannot continue with a different Codex account");
	}
}

function sameWindow(left: AstraWindowIdentity, right: AstraWindowIdentity): boolean {
	return left.sessionId === right.sessionId &&
		left.firstWindowId === right.firstWindowId &&
		left.currentWindowId === right.currentWindowId &&
		left.previousWindowId === right.previousWindowId &&
		left.windowNumber === right.windowNumber &&
		left.accountId === right.accountId;
}

function assertCurrentRequest(
	model: Model<"openai-codex-responses">,
	sessionId: string | undefined,
	expected: Extract<AstraWindowLookup, { readonly kind: "required" }>,
	getWindow: (sessionId: string | undefined) => AstraWindowLookup,
): void {
	assertCodexModel(model);
	const current = getWindow(sessionId);
	if (current.kind !== "required" || !sameWindow(current.window, expected.window) || current.leafId !== expected.leafId) {
		throw new Error("Astra remote context changed before native dispatch");
	}
}

function assertRecoveryTools(context: Context): void {
	const activeTools = new Set(context.tools?.map((tool) => tool.name));
	if (!activeTools.has("history") || !activeTools.has("notes")) {
		throw new Error("Astra remote context requires active history and notes tools");
	}
}

export function assertFinalRecoveryNamespaces(payload: unknown): void {
	if (!isRecord(payload) || !Array.isArray(payload["tools"])) {
		throw new Error("Astra remote context requires exactly one history and notes namespace");
	}
	const names = payload["tools"].flatMap((tool) =>
		isRecord(tool) && tool["type"] === "namespace" && (tool["name"] === "history" || tool["name"] === "notes")
			? [tool["name"]]
			: [],
	);
	if (names.filter((name) => name === "history").length !== 1 || names.filter((name) => name === "notes").length !== 1) {
		throw new Error("Astra remote context requires exactly one history and notes namespace");
	}
}

function encryptedOutput(details: unknown): string | undefined {
	if (!isRecord(details) || !Object.hasOwn(details, "astraHistoryNotes")) return undefined;
	if (!isRecord(details["astraHistoryNotes"])) throw new Error("Astra remote context has invalid persisted recovery metadata");
	if (!Object.hasOwn(details["astraHistoryNotes"], "encrypted_output")) return undefined;
	const output = details["astraHistoryNotes"]["encrypted_output"];
	if (typeof output !== "string" || output === "") throw new Error("Astra remote context has invalid persisted encrypted output");
	return output;
}

export function replayEncryptedToolOutputs(payload: unknown, context: Context): unknown {
	if (!isRecord(payload) || !Array.isArray(payload["input"])) return payload;
	const encryptedByCallId = new Map<string, { encrypted: string; images: unknown[] }>();
	for (const message of context.messages) {
		if (message.role !== "toolResult") continue;
		const encrypted = encryptedOutput(message.details);
		if (!encrypted) continue;
		const images = message.content
			.filter((block) => block.type === "image")
			.map((block) => ({
				type: "input_image",
				detail: "auto",
				image_url: `data:${block.mimeType};base64,${block.data}`,
			}));
		encryptedByCallId.set(message.toolCallId.split("|")[0] ?? message.toolCallId, { encrypted, images });
	}
	if (encryptedByCallId.size === 0) return payload;
	return {
		...payload,
		input: payload["input"].map((item) => {
			if (!isRecord(item) || item["type"] !== "function_call_output" || typeof item["call_id"] !== "string") return item;
			const replay = encryptedByCallId.get(item["call_id"]);
			return replay
				? { ...item, output: [{ type: "encrypted_content", encrypted_content: replay.encrypted }, ...replay.images] }
				: item;
		}),
	};
}

export function routeAstraNamespaceToolCall(call: ToolCall): ToolCall {
	if (call.namespace !== "history" && call.namespace !== "notes") return call;
	const valid = call.namespace === "history" ? isHistoryAction(call.name) : isNotesAction(call.name);
	if (!valid) throw new Error(`Astra rejected unsupported ${call.namespace} operation`);
	if (Object.hasOwn(call.arguments, "action") || Object.hasOwn(call.arguments, "context")) {
		throw new Error("Astra rejected injected namespace action or context");
	}
	return { ...call, name: call.namespace, arguments: { action: call.name, ...call.arguments } };
}

export function unrouteAstraNamespaceToolCall(call: ToolCall): ToolCall {
	if ((call.namespace !== "history" && call.namespace !== "notes") || call.name !== call.namespace) return call;
	const action = call.arguments["action"];
	const valid = call.namespace === "history" ? isHistoryAction(action) : isNotesAction(action);
	if (!valid || Object.hasOwn(call.arguments, "context")) {
		throw new Error(`Astra rejected malformed ${call.namespace} replay operation`);
	}
	const { action: _action, ...arguments_ } = call.arguments;
	return { ...call, name: action, arguments: arguments_ };
}

function routeMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) => block.type === "toolCall" ? routeAstraNamespaceToolCall(block) : block),
	};
}

function unrouteContext(context: Context): Context {
	return {
		...context,
		messages: context.messages.map((message) => message.role === "assistant"
			? { ...message, content: message.content.map((block) => block.type === "toolCall" ? unrouteAstraNamespaceToolCall(block) : block) }
			: message),
	};
}

function routeEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: routeMessage(event.message) };
	if (event.type === "error") return { ...event, error: routeMessage(event.error) };
	const partial = routeMessage(event.partial);
	return event.type === "toolcall_end"
		? { ...event, toolCall: routeAstraNamespaceToolCall(event.toolCall), partial }
		: { ...event, partial };
}

function routeNamespaceToolStream(source: AssistantMessageEventStream): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		let latest: AssistantMessage | undefined;
		try {
			for await (const event of source) {
				const routed = routeEvent(event);
				latest = routed.type === "done" ? routed.message : routed.type === "error" ? routed.error : routed.partial;
				output.push(routed);
				if (routed.type === "done") output.end(routed.message);
				if (routed.type === "error") output.end(routed.error);
			}
		} catch (error) {
			if (!latest) throw error;
			const failed: AssistantMessage = {
				...latest,
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			output.push({ type: "error", reason: "error", error: failed });
			output.end(failed);
		}
	})();
	return output;
}

interface ProtectedAstraOptions extends StreamOptions {
	readonly beforeTransportAttempt: (headers: Headers) => Promise<void>;
}

export function createAstraCodexProvider(
	native: Provider<"openai-codex-responses">,
	getWindow: (sessionId: string | undefined) => AstraWindowLookup,
	resolveCurrentAuth: () => Promise<AstraCodexAuth>,
): Provider<"openai-codex-responses"> {
	const validateAttempt = async (
		headers: Headers,
		model: Model<"openai-codex-responses">,
		sessionId: string | undefined,
		lookup: Extract<AstraWindowLookup, { readonly kind: "required" }>,
	): Promise<void> => {
		assertCurrentRequest(model, sessionId, lookup, getWindow);
		const auth = await resolveCurrentAuth();
		assertCurrentRequest(model, sessionId, lookup, getWindow);
		if (auth.accountId !== lookup.window.accountId) {
			throw new Error("Astra remote context cannot continue with a different Codex account");
		}
		headers.set("authorization", auth.authorization);
		headers.set("chatgpt-account-id", auth.accountId);
	};
	const protectOptions = (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: StreamOptions,
		lookup: Extract<AstraWindowLookup, { readonly kind: "required" }>,
	): ProtectedAstraOptions => {
		const window = lookup.window;
		assertCurrentRequest(model, options.sessionId, lookup, getWindow);
		assertWindowAccount(options.headers, window);
		assertRecoveryTools(context);
		const metadata: AstraRequestMetadata = {
			session_id: window.sessionId,
			thread_id: window.sessionId,
			agent_name: "/root",
			window_id: `${window.sessionId}:${window.windowNumber}`,
			window_number: window.windowNumber,
			context_window_id: window.currentWindowId,
			request_kind: "turn",
			history_ingest_requested: true,
		};
		return {
			// Preserve each native profile's optional fields; change only the shared hooks and headers.
			...options,
			headers: {
				...options.headers,
				"x-codex-window-id": metadata.window_id,
				"x-codex-turn-metadata": JSON.stringify(metadata),
			},
			onPayload: async (payload, payloadModel) => {
				if (!isRecord(payload) || !Array.isArray(payload["input"])) {
					throw new Error("Astra remote context requires structured native input");
				}
				const originalInput = structuredClone(payload["input"]);
				const candidate = await options.onPayload?.(payload, payloadModel) ?? payload;
				assertCurrentRequest(model, options.sessionId, lookup, getWindow);
				if (!isRecord(candidate) || candidate["model"] !== model.id || !isDeepStrictEqual(candidate["input"], originalInput)) {
					throw new Error("Astra remote context rejected a modified native model or input");
				}
				const rewritten = replayEncryptedToolOutputs(rewriteReservedTools(candidate), context);
				const finalPayload = withWindowMetadata(rewritten, metadata);
				assertFinalRecoveryNamespaces(finalPayload);
				return finalPayload;
			},
			beforeTransportAttempt: (headers) => validateAttempt(headers, model, options.sessionId, lookup),
		};
	};
	const streamSimple = (
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const lookup = getWindow(options?.sessionId);
		if (lookup.kind === "ordinary") return native.streamSimple(model, context, options);
		if (lookup.kind === "invalid") throw new Error(lookup.reason);
		return routeNamespaceToolStream(native.streamSimple(model, unrouteContext(context), protectOptions(model, context, options ?? {}, lookup)));
	};
	const stream = (
		model: Model<"openai-codex-responses">,
		context: Context,
		options?: ApiStreamOptions<"openai-codex-responses">,
	): AssistantMessageEventStream => {
		const lookup = getWindow(options?.sessionId);
		if (lookup.kind === "ordinary") return native.stream(model, context, options);
		if (lookup.kind === "invalid") throw new Error(lookup.reason);
		return routeNamespaceToolStream(native.stream(model, unrouteContext(context), protectOptions(model, context, options ?? {}, lookup)));
	};
	return { ...native, stream, streamSimple };
}

export { ASTRA_WINDOW_MESSAGE_TYPE };
