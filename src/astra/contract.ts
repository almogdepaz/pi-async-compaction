/*
 * Adapted from @howaboua/pi-codex-conversion at 7021ae48e8efe36a3becc5830d529696ff798e5e.
 * Copyright (c) 2026 Igor Warzocha. MIT License; see ATTRIBUTION.md.
 */

export const HISTORY_ACTIONS = [
	"list_windows",
	"list_items",
	"read_item",
	"search_contents",
] as const;

export const NOTES_ACTIONS = [
	"list_files_by_prefix",
	"read_file",
	"search_contents",
	"append_to_file",
	"write_file",
] as const;

export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
export type NotesAction = (typeof NOTES_ACTIONS)[number];

type JsonSchema = Record<string, unknown>;
type ContextNamespace = "history" | "notes";

export interface ReservedOperation {
	readonly type: "function";
	readonly name: string;
	readonly description: string;
	readonly strict: false;
	readonly parameters: JsonSchema;
}

export interface ReservedNamespace {
	readonly type: "namespace";
	readonly name: ContextNamespace;
	readonly description: string;
	readonly tools: readonly ReservedOperation[];
}

const HISTORY_FIELDS: Record<HistoryAction, readonly string[]> = {
	list_windows: ["agent_name", "limit", "recent_first"],
	list_items: ["agent_name", "limit", "max_chars_per_item", "recent_first", "role", "tool_name", "tool_namespace", "window_id"],
	read_item: ["agent_name", "item_id", "limit_chars", "offset_chars", "window_id"],
	search_contents: ["agent_name", "limit", "query", "recent_first", "role", "tool_name", "tool_namespace", "window_id"],
};

const NOTES_FIELDS: Record<NotesAction, readonly string[]> = {
	list_files_by_prefix: ["file_order", "file_order_by", "max_results", "prefix"],
	read_file: ["path", "start_line", "stop_line"],
	search_contents: ["max_files", "max_matches_per_file", "path_prefix", "query", "recent_file_first"],
	append_to_file: ["path", "text"],
	write_file: ["path", "text"],
};

function nullable(type: string): JsonSchema {
	return { anyOf: [{ type }, { type: "null" }] };
}

function integer(): JsonSchema {
	// The reserved wire schema intentionally omits local numeric bounds.
	return { type: "integer" };
}

function nullableRole(): JsonSchema {
	return { anyOf: [{ type: "string", enum: ["user", "assistant", "tool", "system", "developer"] }, { type: "null" }] };
}

function text(description?: string, encrypted = false): JsonSchema {
	return { type: "string", ...(description ? { description } : {}), ...(encrypted ? { encrypted: true } : {}) };
}

function object(properties: Record<string, JsonSchema>, required?: readonly string[]): JsonSchema {
	return { type: "object", properties, ...(required ? { required } : {}) };
}

function operation(name: string, description: string, parameters: JsonSchema): ReservedOperation {
	return { type: "function", name, description, strict: false, parameters };
}

export function createReservedContextNamespaces(): readonly ReservedNamespace[] {
	return [
		{
			type: "namespace",
			name: "history",
			description: "Prior-window detail. Pass IDs unchanged. Search, never browse.",
			tools: [
				operation("list_windows", "List context windows", object({ agent_name: nullable("string"), limit: integer(), recent_first: { type: "boolean" } })),
				operation("list_items", "List history items", object({ agent_name: nullable("string"), limit: integer(), max_chars_per_item: integer(), recent_first: { type: "boolean" }, role: nullableRole(), tool_name: nullable("string"), tool_namespace: nullable("string"), window_id: nullable("string") })),
				operation("read_item", "Read history item range", object({ agent_name: nullable("string"), item_id: text("Suffix from the item's [id: …] marker."), limit_chars: integer(), offset_chars: integer(), window_id: text() }, ["item_id", "window_id"])),
				operation("search_contents", "Search history", object({ agent_name: nullable("string"), limit: integer(), query: text("Case-sensitive", true), recent_first: { type: "boolean" }, role: nullableRole(), tool_name: nullable("string"), tool_namespace: nullable("string"), window_id: nullable("string") }, ["query"])),
			],
		},
		{
			type: "namespace",
			name: "notes",
			description: "Cross-window checkpoints on virtual paths. Relative uses current agent; cross-agent uses <agent>/notes[/path].",
			tools: [
				operation("list_files_by_prefix", "List note files", object({ file_order: { type: "string", enum: ["ascending", "descending"] }, file_order_by: { type: "string", enum: ["name", "created_at", "updated_at"] }, max_results: integer(), prefix: nullable("string") })),
				operation("read_file", "Read note file; line bounds inclusive, 1-based, negative from end", object({ path: text(), start_line: nullable("integer"), stop_line: nullable("integer") }, ["path"])),
				operation("search_contents", "Search note lines by literal substring", object({ max_files: integer(), max_matches_per_file: integer(), path_prefix: nullable("string"), query: text("Case-sensitive", true), recent_file_first: { type: "boolean" } }, ["query"])),
				operation("append_to_file", "Append text exactly", object({ path: text(), text: text(undefined, true) }, ["text", "path"])),
				operation("write_file", "Create or replace a note file", object({ path: text(), text: text(undefined, true) }, ["text", "path"])),
			],
		},
	];
}

function validateFields(
	namespace: ContextNamespace,
	action: string,
	arguments_: Record<string, unknown>,
	allowed: readonly string[],
): void {
	for (const field of Object.keys(arguments_)) {
		if (field === "action") continue;
		if (!allowed.includes(field)) {
			throw new Error(`${namespace} ${action} does not accept ${field}`);
		}
	}
}

function requireString(namespace: ContextNamespace, action: string, arguments_: Record<string, unknown>, field: string): void {
	if (typeof arguments_[field] !== "string" || arguments_[field] === "") {
		throw new Error(`${namespace} ${action} requires ${field}`);
	}
}

export function validateHistoryAction(action: HistoryAction, arguments_: Record<string, unknown>): void {
	validateFields("history", action, arguments_, HISTORY_FIELDS[action]);
	if (action === "read_item") {
		requireString("history", action, arguments_, "item_id");
		requireString("history", action, arguments_, "window_id");
	}
	if (action === "search_contents") requireString("history", action, arguments_, "query");
}

export function validateNotesAction(action: NotesAction, arguments_: Record<string, unknown>): void {
	validateFields("notes", action, arguments_, NOTES_FIELDS[action]);
	if (action === "read_file" || action === "append_to_file" || action === "write_file") {
		requireString("notes", action, arguments_, "path");
	}
	if (action === "search_contents") requireString("notes", action, arguments_, "query");
	if (action === "append_to_file" || action === "write_file") requireString("notes", action, arguments_, "text");
}

export function isHistoryAction(value: unknown): value is HistoryAction {
	return typeof value === "string" && (HISTORY_ACTIONS as readonly string[]).includes(value);
}

export function isNotesAction(value: unknown): value is NotesAction {
	return typeof value === "string" && (NOTES_ACTIONS as readonly string[]).includes(value);
}
