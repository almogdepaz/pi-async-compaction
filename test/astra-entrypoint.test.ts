import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { isAstraRemoteModel, REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE } from "../src/astra/activation";
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

test("requests remote-window compaction at the shared configured start ratio", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-astra-trigger-"));
	const previousRatio = process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
	const previousEnabled = process.env.PI_ASYNC_PREFIX_COMPACTION;
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
		}));
		process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = "0.5";
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;

		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		astraRemoteContext({
			registerContextHandler: () => undefined,
			registerTool: () => undefined,
			getAllTools: () => [],
			getToolDefinition: () => undefined,
			getActiveTools: () => [],
			setActiveTools: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		} as never);
		const turnEnd = handlers.get("turn_end");
		if (!turnEnd) throw new Error("expected turn_end handler");
		let requests = 0;
		const context = (tokens: number | null, isRemote = true) => ({
			cwd,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens, contextWindow: 40_000 }),
			requestCompactionBeforeNextTurn: () => {
				requests++;
				return true;
			},
			sessionManager: {
				getEntries: () => isRemote ? [{ type: "custom", customType: REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE }] : [],
			},
		});

		turnEnd({}, context(20_001));
		expect(requests).toBe(1);
		turnEnd({}, context(20_000));
		turnEnd({}, context(null));
		turnEnd({}, context(19_999));
		expect(requests).toBe(1);
		expect(() => turnEnd({}, {
			...context(20_001),
			getContextUsage: () => {
				throw new Error("unexpected usage failure");
			},
		})).toThrow("unexpected usage failure");
		process.env.PI_ASYNC_PREFIX_COMPACTION = "0";
		turnEnd({}, context(20_001));
		expect(requests).toBe(1);
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1 },
		}));
		turnEnd({}, context(20_001));
		turnEnd({}, context(20_001, false));
		expect(requests).toBe(1);
	} finally {
		if (previousRatio === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
		else process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = previousRatio;
		if (previousEnabled === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		else process.env.PI_ASYNC_PREFIX_COMPACTION = previousEnabled;
		await rm(cwd, { recursive: true, force: true });
	}
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
