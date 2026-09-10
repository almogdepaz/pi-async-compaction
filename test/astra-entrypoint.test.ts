import { expect, test } from "bun:test";
import { isAstraRemoteModel } from "../src/astra/activation";
import astraRemoteContext from "../src/astra/index";

const model = {
	provider: "openai-codex",
	id: "gpt-6-astra",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

test("matches only the bundled Astra subscription model identity", () => {
	expect(isAstraRemoteModel(model)).toBe(true);
	expect(isAstraRemoteModel({ ...model, id: "gpt-5.6-terra" })).toBe(false);
	expect(isAstraRemoteModel({ ...model, provider: "openai" })).toBe(false);
});

test("activates the model-selected entrypoint with a bound account and provider bridge", async () => {
	const prior = process.env.PI_ASTRA_REMOTE_CONTEXT;
	delete process.env.PI_ASTRA_REMOTE_CONTEXT;
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sent: Record<string, unknown>[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let contextHandler: (() => void) | undefined;
	let provider: { readonly id: string } | undefined;
	const nativeProvider = { id: "openai-codex" };
	const astraToolSource = {};
	const registeredTools: Array<{ readonly definition: { readonly name: string }; readonly sourceInfo: object }> = [];
	let activeTools: string[] = [];
	try {
		astraRemoteContext({
			registerContextHandler: (_id: string, _version: number, assertActive: () => void) => {
				contextHandler = assertActive;
			},
			registerProvider: (registered: { readonly id: string }) => {
				provider = registered;
			},
			registerTool: (tool: { readonly name: string }) => {
				registeredTools.push({ definition: tool, sourceInfo: astraToolSource });
			},
			getAllTools: () => registeredTools.map(({ definition, sourceInfo }) => ({ name: definition.name, sourceInfo })),
			getToolDefinition: (name: string) => registeredTools.find((tool) => tool.definition.name === name)?.definition,
			getActiveTools: () => activeTools,
			setActiveTools: (names: string[]) => { activeTools = names; },
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
			},
			appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
			sendMessage: (message: unknown) => sent.push(message as Record<string, unknown>),
		} as never);
		await handlers.get("session_start")?.({}, {
			model,
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => null,
				getBranch: () => sent.map((message, index) => ({ id: `entry-${index}`, type: "custom_message", ...message })),
				getEntries: () => entries.map(({ customType, data }) => ({ type: "custom", customType, data })),
			},
			modelRegistry: {
				getProviderAuth: async () => ({ auth: { apiKey: "token-1", headers: { "chatgpt-account-id": "account-1" } } }),
				getProvider: () => provider ?? nativeProvider,
			},
		} as never);
		expect(entries).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(provider).toBeDefined();
		expect(contextHandler).toBeDefined();
		expect(contextHandler).not.toThrow();
		const compaction = await handlers.get("session_before_compact")?.({
			reason: "threshold",
			signal: new AbortController().signal,
			preparation: { firstKeptEntryId: "entry-0", tokensBefore: 10_000 },
		}, {
			model,
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => null,
				getBranch: () => sent.map((message, index) => ({ id: `entry-${index}`, type: "custom_message", ...message })),
				getEntries: () => [{ type: "custom", customType: "pi.required-context-handler" }],
			},
			modelRegistry: {
				getProviderAuth: async () => ({ auth: { apiKey: "token-1", headers: { "chatgpt-account-id": "account-1" } } }),
			},
		} as never);
		expect(compaction).toMatchObject({
			compaction: {
				summary: "[Astra remote context-window boundary; no plaintext conversation summary was generated.]",
				firstKeptEntryId: "entry-0",
				details: {
					protocol: 1,
					strategy: "astra-remote-window",
					window: { sessionId: "session-1", accountId: "account-1", windowNumber: 1 },
				},
			},
		});
		expect(sent).toHaveLength(1);
	} finally {
		if (prior === undefined) delete process.env.PI_ASTRA_REMOTE_CONTEXT;
		else process.env.PI_ASTRA_REMOTE_CONTEXT = prior;
	}
});
