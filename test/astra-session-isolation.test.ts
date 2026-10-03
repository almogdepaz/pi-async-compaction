import { expect, test } from "bun:test";
import astraRemoteContext from "../src/astra/index";

const model = {
	provider: "openai-codex",
	id: "gpt-6-astra",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

test("rejects a provider request whose session id differs from the active remote session", async () => {
	const prior = process.env.PI_ASTRA_COMPACTION_MODE;
	process.env.PI_ASTRA_COMPACTION_MODE = "summary";
	const entries: Array<Record<string, unknown>> = [];
	const branch: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let activeTools: string[] = [];
	let nativeDispatches = 0;
	let provider: Record<string, unknown> = {
		id: "openai-codex",
		auth: { oauth: { toAuth: async () => ({ apiKey: "token" }), login: async () => { throw new Error("unexpected login"); }, refresh: async () => { throw new Error("unexpected refresh"); } } },
		stream: () => {
			nativeDispatches++;
			throw new Error("native dispatch reached");
		},
		streamSimple: () => {
			nativeDispatches++;
			throw new Error("native dispatch reached");
		},
	};
	const context = {
		model,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-a",
			getLeafId: () => "leaf-a",
			getEntries: () => entries,
			getBranch: () => branch,
		},
		modelRegistry: {
			getProvider: () => provider,
			getProviderAuth: async () => ({ auth: { apiKey: "token", headers: { "chatgpt-account-id": "account-a" } } }),
		},
	};
	try {
		astraRemoteContext({
			registerCommand: (_name: string, definition: { readonly handler: (args: string, ctx: unknown) => Promise<void> }) => { command = definition.handler; },
			registerProvider: (next: Record<string, unknown>) => { provider = next; },
			unregisterProvider: () => undefined,
			registerTool: () => undefined,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => { activeTools = names; },
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			sendMessage: (message: Record<string, unknown>) => branch.push({ id: `entry-${branch.length}`, type: "custom_message", ...message }),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		} as never);
		await handlers.get("session_start")?.({}, context);
		if (!command) throw new Error("expected /astra command");
		await command("remote", context);

		const stream = provider.stream as (requestModel: typeof model, transcript: unknown, options: { readonly sessionId: string }) => unknown;
		expect(() => stream(model, {
			messages: [{ role: "system", content: "system", toolsAdded: [{ name: "history" }, { name: "notes" }], timestamp: 0 }],
		}, { sessionId: "session-b" })).toThrow("missing compatible persisted window state");
		expect(nativeDispatches).toBe(0);
	} finally {
		if (prior === undefined) delete process.env.PI_ASTRA_COMPACTION_MODE;
		else process.env.PI_ASTRA_COMPACTION_MODE = prior;
	}
});
