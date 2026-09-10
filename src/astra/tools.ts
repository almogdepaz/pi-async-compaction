import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	HISTORY_ACTIONS,
	isHistoryAction,
	isNotesAction,
	NOTES_ACTIONS,
	validateHistoryAction,
	validateNotesAction,
} from "./contract";
import {
	ASTRA_HISTORY_ENDPOINTS,
	ASTRA_NOTES_ENDPOINTS,
	callAstraBackend,
} from "./remote-client";
import type { AstraWindowIdentity } from "./provider";

const HISTORY_PARAMETERS = Type.Object(
	{
		action: Type.Union(HISTORY_ACTIONS.map((action) => Type.Literal(action))),
		agent_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		item_id: Type.Optional(Type.String()),
		limit: Type.Optional(Type.Integer({ minimum: 1 })),
		limit_chars: Type.Optional(Type.Integer({ minimum: 1 })),
		max_chars_per_item: Type.Optional(Type.Integer({ minimum: 1 })),
		offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
		query: Type.Optional(Type.String()),
		recent_first: Type.Optional(Type.Boolean()),
		role: Type.Optional(Type.Union([
			Type.Literal("user"),
			Type.Literal("assistant"),
			Type.Literal("tool"),
			Type.Literal("system"),
			Type.Literal("developer"),
			Type.Null(),
		])),
		tool_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		tool_namespace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);

const NOTES_PARAMETERS = Type.Object(
	{
		action: Type.Union(NOTES_ACTIONS.map((action) => Type.Literal(action))),
		file_order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")])),
		file_order_by: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("created_at"), Type.Literal("updated_at")])),
		max_files: Type.Optional(Type.Integer({ minimum: 1 })),
		max_matches_per_file: Type.Optional(Type.Integer({ minimum: 1 })),
		max_results: Type.Optional(Type.Integer({ minimum: 1 })),
		path: Type.Optional(Type.String()),
		path_prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		prefix: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		query: Type.Optional(Type.String()),
		recent_file_first: Type.Optional(Type.Boolean()),
		start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		text: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export interface AstraHistoryNotesDetails {
	readonly astraHistoryNotes: Record<string, unknown>;
}

function contentFor(result: Record<string, unknown>): string {
	return typeof result["encrypted_output"] === "string"
		? "context operation completed"
		: JSON.stringify(result);
}

function withoutAction(params: Record<string, unknown>): Record<string, unknown> {
	const { action: _action, context: _context, ...arguments_ } = params;
	return arguments_;
}

async function executeHistory(
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	getExpectedWindow: () => AstraWindowIdentity | undefined,
): Promise<AgentToolResult<AstraHistoryNotesDetails>> {
	if (!isHistoryAction(params["action"])) throw new Error("history requires a supported action");
	validateHistoryAction(params["action"], params);
	const result = await callAstraBackend(ctx, ASTRA_HISTORY_ENDPOINTS[params["action"]], withoutAction(params), signal, {
		mode: "tokens",
		limit: 10_000,
	}, getExpectedWindow);
	return {
		content: [{ type: "text", text: contentFor(result.output) }, ...result.images],
		details: { astraHistoryNotes: result.output },
	};
}

async function executeNotes(
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	getExpectedWindow: () => AstraWindowIdentity | undefined,
): Promise<AgentToolResult<AstraHistoryNotesDetails>> {
	if (!isNotesAction(params["action"])) throw new Error("notes requires a supported action");
	validateNotesAction(params["action"], params);
	const result = await callAstraBackend(ctx, ASTRA_NOTES_ENDPOINTS[params["action"]], withoutAction(params), signal, {
		mode: "tokens",
		limit: 10_000,
	}, getExpectedWindow);
	return {
		content: [{ type: "text", text: contentFor(result.output) }, ...result.images],
		details: { astraHistoryNotes: result.output },
	};
}

export function registerAstraHistoryNotesTools(
	pi: ExtensionAPI,
	getExpectedWindow: () => AstraWindowIdentity | undefined,
): { readonly history: Pick<ToolDefinition, "name">; readonly notes: Pick<ToolDefinition, "name"> } {
	const history: ToolDefinition<typeof HISTORY_PARAMETERS, AstraHistoryNotesDetails> = {
		name: "history",
		label: "history",
		description: "Prior-window detail. Pass IDs unchanged. Search, never browse.",
		parameters: HISTORY_PARAMETERS,
		async execute(_id, params, signal, _update, ctx) {
			return executeHistory(params, ctx, signal, getExpectedWindow);
		},
	};
	const notes: ToolDefinition<typeof NOTES_PARAMETERS, AstraHistoryNotesDetails> = {
		name: "notes",
		label: "notes",
		description: "Cross-window checkpoints on virtual paths.",
		parameters: NOTES_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			return executeNotes(params, ctx, signal, getExpectedWindow);
		}
	};
	pi.registerTool(history);
	pi.registerTool(notes);
	return { history, notes };
}
