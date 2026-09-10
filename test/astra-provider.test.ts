import { expect, test } from "bun:test";
import {
	assertFinalRecoveryNamespaces,
	replayEncryptedToolOutputs,
	routeAstraNamespaceToolCall,
	unrouteAstraNamespaceToolCall,
} from "../src/astra/provider";

test("routes the authoritative namespace operation and rejects injected identity", () => {
	expect(
		routeAstraNamespaceToolCall({
			type: "toolCall",
			id: "call-1",
			name: "write_file",
			namespace: "notes",
			arguments: { path: "state", text: "checkpoint" },
		}),
	).toMatchObject({ name: "notes", arguments: { action: "write_file", path: "state", text: "checkpoint" } });
	expect(() =>
		routeAstraNamespaceToolCall({
			type: "toolCall",
			id: "call-2",
			name: "write_file",
			namespace: "notes",
			arguments: { action: "read_file", path: "state", text: "checkpoint" },
		}),
	).toThrow("rejected injected namespace action or context");
});

test("unroutes locally executed namespace calls before native replay", () => {
	expect(
		unrouteAstraNamespaceToolCall({
			type: "toolCall",
			id: "call-1",
			name: "notes",
			namespace: "notes",
			arguments: { action: "write_file", path: "state", text: "checkpoint" },
		}),
	).toMatchObject({ name: "write_file", namespace: "notes", arguments: { path: "state", text: "checkpoint" } });
});

test("rejects missing or duplicate final recovery namespaces", () => {
	expect(() => assertFinalRecoveryNamespaces({ tools: [{ type: "namespace", name: "history" }] })).toThrow("requires exactly one history and notes namespace");
	expect(() => assertFinalRecoveryNamespaces({
		tools: [
			{ type: "namespace", name: "history" },
			{ type: "namespace", name: "notes" },
			{ type: "namespace", name: "notes" },
		],
	})).toThrow("requires exactly one history and notes namespace");
	expect(() => assertFinalRecoveryNamespaces({
		tools: [{ type: "namespace", name: "history" }, { type: "namespace", name: "notes" }],
	})).not.toThrow();
});

test.each([null, 7, ""])("rejects malformed persisted encrypted output %p rather than replaying status text", (encrypted) => {
	expect(() => replayEncryptedToolOutputs(
		{ input: [{ type: "function_call_output", call_id: "call", output: "context operation completed" }] },
		{ messages: [{ role: "toolResult", toolCallId: "call", toolName: "history", content: [{ type: "text", text: "context operation completed" }], details: { astraHistoryNotes: { encrypted_output: encrypted } }, isError: false, timestamp: 0 }] },
	)).toThrow("invalid persisted encrypted output");
});

test("rejects malformed owned recovery metadata rather than treating it as an ordinary result", () => {
	expect(() => replayEncryptedToolOutputs(
		{ input: [{ type: "function_call_output", call_id: "call", output: "context operation completed" }] },
		{ messages: [{ role: "toolResult", toolCallId: "call", toolName: "history", content: [], details: { astraHistoryNotes: null }, isError: false, timestamp: 0 }] },
	)).toThrow("invalid persisted recovery metadata");
});

test("keeps valid persisted plaintext receipts when ciphertext is absent", () => {
	const payload = { input: [{ type: "function_call_output", call_id: "call", output: '{"written":true}' }] };
	expect(replayEncryptedToolOutputs(payload, {
		messages: [{ role: "toolResult", toolCallId: "call", toolName: "notes", content: [{ type: "text", text: '{"written":true}' }], details: { astraHistoryNotes: { written: true } }, isError: false, timestamp: 0 }],
	})).toEqual(payload);
});

test("replays encrypted tool output instead of displayed status text", () => {
	const payload = replayEncryptedToolOutputs(
		{ input: [{ type: "function_call_output", call_id: "call-1", output: "context operation completed" }] },
		{
			messages: [{
				role: "toolResult",
				toolCallId: "call-1|item-1",
				toolName: "notes",
				content: [{ type: "text", text: "context operation completed" }],
				details: { astraHistoryNotes: { encrypted_output: "opaque-ciphertext" } },
				isError: false,
				timestamp: 0,
			}],
		},
	);
	expect(payload).toEqual({
		input: [{
			type: "function_call_output",
			call_id: "call-1",
			output: [{ type: "encrypted_content", encrypted_content: "opaque-ciphertext" }],
		}],
	});
});
