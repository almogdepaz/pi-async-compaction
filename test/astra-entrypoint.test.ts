import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import * as astraActivation from "../src/astra/activation";
import * as astraProvider from "../src/astra/provider";
import { isAstraRemoteModel, REQUIRED_CONTEXT_HANDLER_ENTRY_TYPE } from "../src/astra/activation";
import astraRemoteContext from "../src/astra/index";

const model = {
	provider: "openai-codex",
	id: "gpt-6-astra",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

test("defaults Astra to summary unless PI_ASTRA_COMPACTION_MODE selects remote", () => {
	const getAstraMode = (astraActivation as Record<string, unknown>).getAstraMode;
	expect(typeof getAstraMode).toBe("function");
	if (typeof getAstraMode !== "function") return;
	expect(getAstraMode([], {})).toBe("summary");
	expect(getAstraMode([], { PI_ASTRA_COMPACTION_MODE: "remote" })).toBe("remote");
	expect(getAstraMode([], { PI_ASTRA_COMPACTION_MODE: "summary" })).toBe("summary");
	expect(() => getAstraMode([], { PI_ASTRA_COMPACTION_MODE: "1" })).toThrow("PI_ASTRA_COMPACTION_MODE");
});

test("persists valid slash-selected Astra modes and rejects malformed durable modes", () => {
	const getAstraMode = (astraActivation as Record<string, unknown>).getAstraMode;
	const modeEntryType = (astraActivation as Record<string, unknown>).ASTRA_MODE_ENTRY_TYPE;
	expect(typeof getAstraMode).toBe("function");
	expect(typeof modeEntryType).toBe("string");
	if (typeof getAstraMode !== "function" || typeof modeEntryType !== "string") return;
	expect(getAstraMode([{ type: "custom", customType: modeEntryType, data: { protocol: 1, mode: "remote" } }], {})).toBe("remote");
	expect(getAstraMode([{ type: "custom", customType: modeEntryType, data: { protocol: 1, mode: "summary" } }], { PI_ASTRA_COMPACTION_MODE: "remote" })).toBe("summary");
	expect(() => getAstraMode([{ type: "custom", customType: modeEntryType, data: { mode: "remote" } }], {})).toThrow("malformed persisted Astra mode");
	expect(() => getAstraMode([{ type: "custom", customType: modeEntryType, data: { protocol: 1, mode: "invalid" } }], {})).toThrow("malformed persisted Astra mode");
});

test("classifies only structured eligible remote-service statuses for summary fallback", () => {
	const isEligibleAstraServiceUnavailableStatus = (astraProvider as Record<string, unknown>).isEligibleAstraServiceUnavailableStatus;
	expect(typeof isEligibleAstraServiceUnavailableStatus).toBe("function");
	if (typeof isEligibleAstraServiceUnavailableStatus !== "function") return;
	expect(isEligibleAstraServiceUnavailableStatus(429)).toBe(true);
	expect(isEligibleAstraServiceUnavailableStatus(503)).toBe(true);
	expect(isEligibleAstraServiceUnavailableStatus(400)).toBe(false);
	expect(isEligibleAstraServiceUnavailableStatus(401)).toBe(false);
});

test("matches only the bundled Astra subscription model identity", () => {
	expect(isAstraRemoteModel(model)).toBe(true);
	expect(isAstraRemoteModel({ ...model, id: "gpt-5.6-terra" })).toBe(false);
	expect(isAstraRemoteModel({ ...model, provider: "openai" })).toBe(false);
});

test("summary-mode Astra does not request remote-window compaction", async () => {
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
			registerCommand: () => undefined,
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
		turnEnd({}, context(20_000));
		turnEnd({}, context(null));
		turnEnd({}, context(19_999));
		expect(requests).toBe(0);
		expect(() => turnEnd({}, {
			...context(20_001),
			getContextUsage: () => {
				throw new Error("unexpected usage failure");
			},
		})).not.toThrow();
		process.env.PI_ASYNC_PREFIX_COMPACTION = "0";
		turnEnd({}, context(20_001));
		expect(requests).toBe(0);
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1 },
		}));
		turnEnd({}, context(20_001));
		turnEnd({}, context(20_001, false));
		expect(requests).toBe(0);
	} finally {
		if (previousRatio === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
		else process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = previousRatio;
		if (previousEnabled === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		else process.env.PI_ASYNC_PREFIX_COMPACTION = previousEnabled;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("summary-mode Astra leaves the host provider and session untouched", async () => {
	const prior = process.env.PI_ASTRA_COMPACTION_MODE;
	delete process.env.PI_ASTRA_COMPACTION_MODE;
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
			registerCommand: () => undefined,
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
		expect(entries).toHaveLength(0);
		expect(sent).toHaveLength(0);
		expect(provider).toBeUndefined();
		expect(contextHandler).toBeUndefined();
	} finally {
		if (prior === undefined) delete process.env.PI_ASTRA_COMPACTION_MODE;
		else process.env.PI_ASTRA_COMPACTION_MODE = prior;
	}
});
