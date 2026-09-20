import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

const ASTRA_HOST_DIR = process.env.PI_ASTRA_HOST_NODE_MODULES;
const ASTRA_EXTENSION_PATH = process.env.PI_ASTRA_EXTENSION_PATH ?? fileURLToPath(new URL("../src/astra/index.ts", import.meta.url));
const REMOTE_WINDOW_COMPACTION_SUMMARY = "[Astra remote context-window boundary; no plaintext conversation summary was generated.]";
const CONTEXT_WINDOW = 40_000;
const START_THRESHOLD = 20_000;
const FORCE_THRESHOLD = 39_000;

if (ASTRA_HOST_DIR && !existsSync(join(ASTRA_HOST_DIR, "@earendil-works", "pi-coding-agent", "dist", "index.js"))) {
	throw new Error(`PI_ASTRA_HOST_NODE_MODULES does not contain the required Pi host: ${ASTRA_HOST_DIR}`);
}
if (!existsSync(ASTRA_EXTENSION_PATH)) {
	throw new Error(`PI_ASTRA_EXTENSION_PATH does not exist: ${ASTRA_EXTENSION_PATH}`);
}

interface AstraHost {
	readonly createAgentSession: (options: Record<string, unknown>) => Promise<{ readonly session: AstraSession }>;
	readonly DefaultResourceLoader: new (options: Record<string, unknown>) => { reload: () => Promise<void> };
	readonly ModelRuntime: {
		create: (options: Record<string, unknown>) => Promise<{ registerNativeProvider: (provider: unknown) => () => void }>;
	};
	readonly SessionManager: { inMemory: (cwd: string) => AstraSessionManager };
	readonly SettingsManager: { inMemory: (settings: Record<string, unknown>) => unknown };
}

interface AstraSessionManager {
	getEntries: () => Array<Record<string, unknown>>;
}

interface AstraSession {
	readonly model: Record<string, unknown> | undefined;
	readonly messages: readonly { readonly role: string; readonly content: unknown }[];
	readonly bindExtensions: (bindings: Record<string, unknown>) => Promise<void>;
	readonly prompt: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
	readonly dispose: () => void;
	readonly subscribe: (listener: (event: Record<string, unknown>) => void) => () => void;
}

interface AstraAi {
	readonly InMemoryCredentialStore: new () => unknown;
	readonly createFauxCore: (options: Record<string, unknown>) => AstraProviderCore;
	readonly createProvider: (options: Record<string, unknown>) => unknown;
	readonly fauxAssistantMessage: (content: unknown) => unknown;
	readonly fauxToolCall: (name: string, arguments_: Record<string, unknown>) => unknown;
}

interface AstraProviderCore {
	readonly models: Array<Record<string, unknown>>;
	readonly stream: unknown;
	readonly streamSimple: unknown;
	readonly fetchDeferred: unknown;
	readonly cancelDeferred: unknown;
	readonly getModel: () => Record<string, unknown>;
	readonly setResponses: (responses: Array<(context: { readonly messages: readonly AstraMessage[] }) => unknown>) => void;
	readonly state: { readonly callCount: number };
}

interface AstraMessage {
	readonly role: string;
	readonly content: unknown;
}

interface AstraHarness {
	readonly session: AstraSession;
	readonly sessionManager: AstraSessionManager;
	readonly providerCore: AstraProviderCore;
	readonly compactionEvents: Array<Record<string, unknown>>;
	readonly dispose: () => Promise<void>;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { readonly type: "text"; readonly text: string } =>
			Boolean(block && typeof block === "object" && (block as { readonly type?: unknown }).type === "text" && typeof (block as { readonly text?: unknown }).text === "string"),
		)
		.map((block) => block.text)
		.join("");
}

function firstAssistantUsage(sessionManager: AstraSessionManager): number {
	const entry = sessionManager.getEntries().find((candidate) =>
		candidate.type === "message" && (candidate.message as { readonly role?: unknown } | undefined)?.role === "assistant",
	);
	const usage = (entry?.message as { readonly usage?: { readonly totalTokens?: unknown } } | undefined)?.usage?.totalTokens;
	if (typeof usage !== "number") throw new Error("expected first assistant usage");
	return usage;
}

function expectWithinSharedStartWindow(usage: number): void {
	expect(usage).toBeGreaterThan(START_THRESHOLD);
	expect(usage).toBeLessThan(FORCE_THRESHOLD);
}

async function createHarness(responses: Array<(ai: AstraAi, context: { readonly messages: readonly AstraMessage[] }) => unknown>): Promise<AstraHarness> {
	if (!ASTRA_HOST_DIR) throw new Error("PI_ASTRA_HOST_NODE_MODULES is required for the Astra host integration test");
	const cwd = await mkdtemp(join(tmpdir(), "pi-astra-trigger-host-"));
	let session: AstraSession | undefined;
	let unregisterProvider: (() => void) | undefined;
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
		}));
		const host = await import(`${ASTRA_HOST_DIR}/@earendil-works/pi-coding-agent/dist/index.js`) as unknown as AstraHost;
		const ai = await import(`${ASTRA_HOST_DIR}/@earendil-works/pi-ai/dist/index.js`) as unknown as AstraAi;
		const providerCore = ai.createFauxCore({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "gpt-6-astra", contextWindow: CONTEXT_WINDOW, maxTokens: 1_000, baseUrl: "https://chatgpt.com/backend-api" }],
		});
		const model = providerCore.getModel();
		Object.assign(model, {
			provider: "openai-codex",
			id: "gpt-6-astra",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const nativeProvider = ai.createProvider({
			id: "openai-codex",
			auth: {
				apiKey: {
					name: "test Codex subscription",
					resolve: async () => ({ auth: { apiKey: "test-token", headers: { "chatgpt-account-id": "test-account" } } }),
				},
			},
			models: providerCore.models,
			api: {
				stream: providerCore.stream,
				streamSimple: providerCore.streamSimple,
				fetchDeferred: providerCore.fetchDeferred,
				cancelDeferred: providerCore.cancelDeferred,
			},
		});
		providerCore.setResponses(responses.map((response) => (context) => response(ai, context)));
		const modelRuntime = await host.ModelRuntime.create({
			credentials: new ai.InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		unregisterProvider = modelRuntime.registerNativeProvider(nativeProvider);
		const settingsManager = host.SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const resourceLoader = new host.DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, ".agent"),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: [ASTRA_EXTENSION_PATH],
			systemPrompt: "Astra trigger integration test",
			appendSystemPrompt: [],
		});
		await resourceLoader.reload();
		const sessionManager = host.SessionManager.inMemory(cwd);
		const created = await host.createAgentSession({
			cwd,
			agentDir: join(cwd, ".agent"),
			model,
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		session = created.session;
		await session.bindExtensions({});
		expect(session.model).toMatchObject({
			provider: "openai-codex",
			id: "gpt-6-astra",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const compactionEvents: Array<Record<string, unknown>> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") compactionEvents.push(event);
		});
		return {
			session,
			sessionManager,
			providerCore,
			compactionEvents,
			dispose: async () => {
				session?.dispose();
				unregisterProvider?.();
				await rm(cwd, { recursive: true, force: true });
			},
		};
	} catch (error) {
		session?.dispose();
		unregisterProvider?.();
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

test.skipIf(!ASTRA_HOST_DIR)("rotates once before a queued tool continuation within the shared start window", async () => {
	const previousRatio = process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
	const previousEnabled = process.env.PI_ASYNC_PREFIX_COMPACTION;
	try {
		process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = "0.5";
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		const firstCall = deferred<void>();
		const releaseFirstCall = deferred<void>();
		const secondRequestContexts: Array<readonly AstraMessage[]> = [];
		const harness = await createHarness([
			async (ai) => {
				firstCall.resolve();
				await releaseFirstCall.promise;
				return ai.fauxAssistantMessage(ai.fauxToolCall("get_context_remaining", {}));
			},
			(ai, context) => {
				secondRequestContexts.push(context.messages);
				return ai.fauxAssistantMessage("queued continuation completed");
			},
		]);
		try {
			const prompt = harness.session.prompt("x".repeat(40_000));
			await firstCall.promise;
			await harness.session.steer("queued continuation");
			releaseFirstCall.resolve();
			await prompt;

			expectWithinSharedStartWindow(firstAssistantUsage(harness.sessionManager));
			expect(harness.providerCore.state.callCount).toBe(2);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.compactionEvents).toEqual([expect.objectContaining({ reason: "deferred", aborted: false })]);
			expect(secondRequestContexts).toHaveLength(1);
			expect(secondRequestContexts[0]?.some((message) => contentText(message.content) === "queued continuation")).toBe(true);
			expect(secondRequestContexts[0]?.some((message) => message.role === "compactionSummary")).toBe(false);
			expect(harness.session.messages.filter((message) => message.role === "user" && contentText(message.content) === "continue")).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	} finally {
		if (previousRatio === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
		else process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = previousRatio;
		if (previousEnabled === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		else process.env.PI_ASYNC_PREFIX_COMPACTION = previousEnabled;
	}
}, 20_000);

test.skipIf(!ASTRA_HOST_DIR)("does not duplicate a manual new_context rotation", async () => {
	const previousRatio = process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
	const previousEnabled = process.env.PI_ASYNC_PREFIX_COMPACTION;
	try {
		process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = "0.5";
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		const harness = await createHarness([
			(ai) => ai.fauxAssistantMessage(ai.fauxToolCall("new_context", {})),
			(ai) => ai.fauxAssistantMessage("manual window rotation completed"),
		]);
		try {
			await harness.session.prompt("x".repeat(40_000));

			expectWithinSharedStartWindow(firstAssistantUsage(harness.sessionManager));
			expect(harness.providerCore.state.callCount).toBe(2);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2);
			expect(harness.session.messages.filter((message) => message.role === "user" && contentText(message.content) === "continue")).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	} finally {
		if (previousRatio === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
		else process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = previousRatio;
		if (previousEnabled === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		else process.env.PI_ASYNC_PREFIX_COMPACTION = previousEnabled;
	}
}, 20_000);

test.skipIf(!ASTRA_HOST_DIR)("rotates after a final reply before the next actual user request within the shared start window", async () => {
	const previousRatio = process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
	const previousEnabled = process.env.PI_ASYNC_PREFIX_COMPACTION;
	try {
		process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = "0.5";
		delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		const firstCall = deferred<void>();
		const releaseFirstCall = deferred<void>();
		const secondRequestContexts: Array<readonly AstraMessage[]> = [];
		const harness = await createHarness([
			async (ai) => {
				firstCall.resolve();
				await releaseFirstCall.promise;
				return ai.fauxAssistantMessage("first final reply");
			},
			(ai, context) => {
				secondRequestContexts.push(context.messages);
				return ai.fauxAssistantMessage("next request completed");
			},
		]);
		try {
			const firstPrompt = harness.session.prompt("x".repeat(40_000));
			await firstCall.promise;
			releaseFirstCall.resolve();
			await firstPrompt;
			await harness.session.prompt("next actual user request");

			expectWithinSharedStartWindow(firstAssistantUsage(harness.sessionManager));
			expect(harness.providerCore.state.callCount).toBe(2);
			const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(compactions).toHaveLength(1);
			expect(compactions[0]).toMatchObject({
				summary: REMOTE_WINDOW_COMPACTION_SUMMARY,
				details: { strategy: "astra-remote-window", window: { windowNumber: 1 } },
			});
			expect(harness.compactionEvents).toEqual([expect.objectContaining({ reason: "manual", aborted: false })]);
			expect(secondRequestContexts).toHaveLength(1);
			expect(secondRequestContexts[0]?.some((message) => contentText(message.content) === "next actual user request")).toBe(true);
			expect(secondRequestContexts[0]?.some((message) => message.role === "compactionSummary")).toBe(false);
			expect(harness.session.messages.filter((message) => message.role === "user" && contentText(message.content) === "continue")).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	} finally {
		if (previousRatio === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO;
		else process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = previousRatio;
		if (previousEnabled === undefined) delete process.env.PI_ASYNC_PREFIX_COMPACTION;
		else process.env.PI_ASYNC_PREFIX_COMPACTION = previousEnabled;
	}
}, 20_000);

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}
