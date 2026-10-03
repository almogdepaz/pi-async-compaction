import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

const STOCK_NODE_MODULES = process.env.PI_ASTRA_HOST_NODE_MODULES;
const STOCK_AI_INDEX = STOCK_NODE_MODULES && join(STOCK_NODE_MODULES, "@earendil-works", "pi-ai", "dist", "index.js");
const STOCK_AGENT_INDEX = STOCK_NODE_MODULES && join(STOCK_NODE_MODULES, "@earendil-works", "pi-coding-agent", "dist", "index.js");

function accessToken(accountId = "account-1"): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		exp: Math.floor(Date.now() / 1_000) + 3_600,
	})).toString("base64url");
	return `e30.${payload}.e30`;
}

interface StockAi {
	readonly InMemoryCredentialStore: new () => {
		modify: (providerId: string, update: () => Promise<unknown>) => Promise<unknown>;
	};
}

interface StockAgent {
	readonly DefaultResourceLoader: new (options: Record<string, unknown>) => { reload: () => Promise<void> };
	readonly ModelRuntime: { create: (options: Record<string, unknown>) => Promise<{ getModel: (provider: string, id: string) => unknown; getAuth: (provider: string) => Promise<{ readonly auth: { readonly apiKey?: string; readonly headers?: Record<string, string> } } | undefined> }> };
	readonly SessionManager: { inMemory: (cwd: string) => { getEntries: () => readonly unknown[] } };
	readonly SettingsManager: { inMemory: (settings: Record<string, unknown>) => unknown };
	readonly createAgentSession: (options: Record<string, unknown>) => Promise<{ readonly session: { prompt: (text: string) => Promise<void>; bindExtensions: (bindings: Record<string, unknown>) => Promise<void>; dispose: () => void; readonly state: unknown }; readonly extensionsResult: { readonly errors: readonly unknown[] } }>;
}

test.skipIf(!STOCK_NODE_MODULES)("stock session_start then /astra remote resolves wrapped native OAuth before remote activation", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-entrypoint-auth-"));
	const access = accessToken();
	const originalFetch = globalThis.fetch;
	try {
		await cp(join(import.meta.dir, "..", "src"), join(scratch, "src"), { recursive: true });
		await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
		await writeFile(join(scratch, "extension.ts"), 'export { default } from "./src/astra/index.ts";\n');
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			throw new Error("unexpected OAuth or backend network request");
		}) as typeof fetch;

		const [{ InMemoryCredentialStore }, { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession }] = await Promise.all([
			import(STOCK_AI_INDEX!) as Promise<StockAi>,
			import(STOCK_AGENT_INDEX!) as Promise<StockAgent>,
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access,
			refresh: "not-used",
			expires: Date.now() + 60 * 60_000,
		}));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
		if (!model) throw new Error("stock Astra model unavailable");
		// Fixture-level public transport setting prevents native WebSocket selection before the guarded SSE fetch boundary.
		const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
		const loader = new DefaultResourceLoader({
			cwd: scratch,
			agentDir: join(scratch, ".agent"),
			settingsManager,
			additionalExtensionPaths: [join(scratch, "extension.ts")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const sessionManager = SessionManager.inMemory(scratch);
		const { session, extensionsResult } = await createAgentSession({
			cwd: scratch,
			agentDir: join(scratch, ".agent"),
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
			noTools: "all",
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		try {
			expect(extensionsResult.errors).toHaveLength(0);
			await session.bindExtensions({});
			await session.prompt("/astra remote");
			const auth = await modelRuntime.getAuth("openai-codex");
			expect(auth?.auth.apiKey).toBe(access);
			expect(auth?.auth.headers?.["chatgpt-account-id"]).toBe("account-1");
			expect(JSON.stringify(sessionManager.getEntries())).toContain('"customType":"astra-remote-context-mode","data":{"protocol":1,"mode":"remote"}');
		} finally {
			session.dispose();
		}
	} finally {
		globalThis.fetch = originalFetch;
		await rm(scratch, { recursive: true, force: true });
	}
});

test.skipIf(!STOCK_NODE_MODULES)("two stock sessions sharing one runtime cannot dispatch through the other session's remote wrapper", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-session-isolation-"));
	const accessA = accessToken("account-a");
	const accessB = accessToken("account-b");
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let dispatchedAccount: string | null = null;
	try {
		await cp(join(import.meta.dir, "..", "src"), join(scratch, "src"), { recursive: true });
		await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
		await writeFile(join(scratch, "extension.ts"), 'export { default } from "./src/astra/index.ts";\n');
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			fetchCalls++;
			dispatchedAccount = new Headers(init?.headers).get("chatgpt-account-id");
			throw new Error("unexpected OAuth or backend network request");
		}) as typeof fetch;

		const [{ InMemoryCredentialStore }, { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession }] = await Promise.all([
			import(STOCK_AI_INDEX!) as Promise<StockAi>,
			import(STOCK_AGENT_INDEX!) as Promise<StockAgent>,
		]);
		const credentials = new InMemoryCredentialStore();
		const store = async (access: string): Promise<void> => {
			await credentials.modify("openai-codex", async () => ({ type: "oauth", access, refresh: "not-used", expires: Date.now() + 60 * 60_000 }));
		};
		await store(accessA);
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
		if (!model) throw new Error("stock Astra model unavailable");
		// Fixture-level public transport setting prevents native WebSocket selection before the guarded SSE fetch boundary.
		const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } });
		const makeSession = async (name: string) => {
			const loader = new DefaultResourceLoader({
				cwd: join(scratch, name),
				agentDir: join(scratch, name, ".agent"),
				settingsManager,
				additionalExtensionPaths: [join(scratch, "extension.ts")],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			return createAgentSession({
				cwd: join(scratch, name),
				agentDir: join(scratch, name, ".agent"),
				modelRuntime,
				model,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(join(scratch, name)),
				settingsManager,
				noTools: "all",
				sessionStartEvent: { type: "session_start", reason: "new" },
			});
		};
		const first = await makeSession("first");
		const second = await makeSession("second");
		try {
			expect(first.extensionsResult.errors).toHaveLength(0);
			expect(second.extensionsResult.errors).toHaveLength(0);
			await first.session.bindExtensions({});
			await second.session.bindExtensions({});
			await first.session.prompt("/astra remote");
			await store(accessB);
			await second.session.prompt("/astra remote");
			await first.session.prompt("cross-session dispatch must fail before fetch");
			expect(fetchCalls).toBe(0);
			expect(dispatchedAccount).toBeNull();
			expect(JSON.stringify(first.session.state)).toContain("missing compatible persisted window state");
		} finally {
			first.session.dispose();
			second.session.dispose();
		}
	} finally {
		globalThis.fetch = originalFetch;
		await rm(scratch, { recursive: true, force: true });
	}
});

test.skipIf(!STOCK_NODE_MODULES)("a terminal 401 after a retried 503 does not downgrade remote mode", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-terminal-status-"));
	const access = accessToken();
	const originalFetch = globalThis.fetch;
	const statuses = [503, 401];
	let fetchCalls = 0;
	try {
		await cp(join(import.meta.dir, "..", "src"), join(scratch, "src"), { recursive: true });
		await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
		await writeFile(join(scratch, "extension.ts"), 'export { default } from "./src/astra/index.ts";\n');
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("controlled terminal status", { status: statuses[fetchCalls++] ?? 500 })) as typeof fetch;
		const [{ InMemoryCredentialStore }, { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession }] = await Promise.all([
			import(STOCK_AI_INDEX!) as Promise<StockAi>,
			import(STOCK_AGENT_INDEX!) as Promise<StockAgent>,
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({ type: "oauth", access, refresh: "not-used", expires: Date.now() + 60 * 60_000 }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
		if (!model) throw new Error("stock Astra model unavailable");
		const settingsManager = SettingsManager.inMemory({ transport: "sse", retry: { enabled: true, provider: { maxRetries: 1, maxRetryDelayMs: 0 } } });
		const loader = new DefaultResourceLoader({
			cwd: scratch, agentDir: join(scratch, ".agent"), settingsManager,
			additionalExtensionPaths: [join(scratch, "extension.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const { session, extensionsResult } = await createAgentSession({
			cwd: scratch, agentDir: join(scratch, ".agent"), modelRuntime, model, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(scratch), settingsManager, noTools: "builtin", sessionStartEvent: { type: "session_start", reason: "new" },
		});
		try {
			expect(extensionsResult.errors).toHaveLength(0);
			await session.bindExtensions({});
			await session.prompt("/astra remote");
			expect((session.state as { readonly tools: readonly { readonly name: string }[] }).tools.map((tool) => tool.name)).toContain("history");
			await session.prompt("terminal status sequence");
			expect((session.state as { readonly errorMessage?: string }).errorMessage).toBe("controlled terminal status");
			expect(fetchCalls).toBe(2);
			expect(JSON.stringify(session.state)).not.toContain("astra-remote-context-fallback");
		} finally {
			session.dispose();
		}
	} finally {
		globalThis.fetch = originalFetch;
		await rm(scratch, { recursive: true, force: true });
	}
});
