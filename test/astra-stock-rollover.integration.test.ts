import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentSession, ExtensionError, ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";

const STOCK_NODE_MODULES = process.env.PI_ASTRA_HOST_NODE_MODULES;
const WINDOW_TYPE = "astra-remote-context-window";

interface WireReply {
	readonly tools: readonly (string | { readonly name: string; readonly namespace: "history" | "notes"; readonly arguments: Record<string, unknown> })[];
	readonly inputTokens: number;
}

function sseReply(reply: WireReply): Response {
	const output = reply.tools.length
		? reply.tools.map((tool, index) => ({ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, ...(typeof tool === "string" ? { name: tool, arguments: "{}" } : { name: tool.name, namespace: tool.namespace, arguments: JSON.stringify(tool.arguments) }), status: "completed" }))
		: [{ type: "message", id: "msg_final", role: "assistant", content: [{ type: "output_text", text: "finished" }], status: "completed" }];
	const events: unknown[] = output.flatMap((item, output_index) => [
		{ type: "response.output_item.added", output_index, item },
		{ type: "response.output_item.done", output_index, item },
	]);
	events.push({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output, usage: { input_tokens: reply.inputTokens, output_tokens: 10, total_tokens: reply.inputTokens + 10 } } });
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

interface StockFixture {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly errors: ExtensionError[];
	readonly requests: Array<{ readonly windowNumber: number | undefined; readonly windowId: string | undefined; readonly redirect: RequestRedirect | undefined; readonly input: readonly Record<string, unknown>[]; readonly tools: readonly unknown[] }>;
	readonly backendCalls: string[];
	readonly contextWindow: number;
	readonly restart: () => Promise<AgentSession>;
	readonly setAccount: (accountId: string) => Promise<void>;
}

interface StockOptions {
	readonly providerRetries?: number;
	readonly backendReply?: () => Response;
	readonly toolOverride?: "history" | "notes";
}

async function withStockSession(
	reply: (request: number, contextWindow: number) => WireReply | Response | Promise<WireReply | Response>,
	check: (fixture: StockFixture) => Promise<void>,
	laterExtension?: ExtensionFactory,
	options: StockOptions = {},
): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-rollover-"));
	const originalFetch = globalThis.fetch;
	const envKeys = ["PI_CODING_AGENT_DIR", "PI_ASTRA_COMPACTION_MODE", "PI_ASYNC_PREFIX_COMPACTION", "PI_ASYNC_PREFIX_COMPACTION_START_RATIO"] as const;
	const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	const sessions: AgentSession[] = [];
	const errors: ExtensionError[] = [];
	const requests: StockFixture["requests"] = [];
	const backendCalls: string[] = [];
	let contextWindow = 0;
	try {
		process.env.PI_CODING_AGENT_DIR = join(scratch, ".agent");
		process.env.PI_ASTRA_COMPACTION_MODE = "remote";
		process.env.PI_ASYNC_PREFIX_COMPACTION = "1";
		process.env.PI_ASYNC_PREFIX_COMPACTION_START_RATIO = "0.5";
		// Independent fixture boundary: native SSE only, synthetic unexpired auth,
		// and rejecting fetch installed before any host/provider module is imported.
		globalThis.fetch = (async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin !== "https://chatgpt.com") throw new Error("unexpected fixture network origin");
			if (url.pathname !== "/backend-api/codex/responses") {
				if (!options.backendReply || !["/backend-api/codex/alpha/history/v2/list_windows", "/backend-api/codex/alpha/notes/v2/write_file"].includes(url.pathname)) throw new Error("unexpected fixture network request");
				backendCalls.push(url.pathname);
				return options.backendReply();
			}
			if (requests.length >= 4) throw new Error("unexpected extra native generation");
			const metadata = JSON.parse(new Headers(init?.headers).get("x-codex-turn-metadata") ?? "null") as { window_number: number; context_window_id: string } | null;
			if (!metadata && requests.length === 0) throw new Error("missing initial remote request metadata");
			const body = await new Response(init?.body).arrayBuffer();
			const decoded = new Headers(init?.headers).get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(body).toString("utf8") : new TextDecoder().decode(body);
			const payload = JSON.parse(decoded) as { input: readonly Record<string, unknown>[]; tools?: unknown };
			const tools = [...(Array.isArray(payload.tools) ? payload.tools : []), ...payload.input.flatMap((item) => Array.isArray(item.tools) ? item.tools : [])];
			requests.push({ windowNumber: metadata?.window_number, windowId: metadata?.context_window_id, redirect: init?.redirect, input: payload.input, tools });
			const response = await reply(requests.length, contextWindow);
			return response instanceof Response ? response : sseReply(response);
		}) as typeof fetch;
		await cp(join(import.meta.dir, "..", "src"), join(scratch, "src"), { recursive: true });
		await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
		await writeFile(join(scratch, "extension.ts"), 'export { default } from "./src/astra/index.ts";\n');
		const settings = { transport: "sse" as const, cacheWarming: "off" as const, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 }, retry: { enabled: false, provider: { maxRetries: options.providerRetries ?? 0, maxRetryDelayMs: 1 } } };
		await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify(settings));
		const [{ InMemoryCredentialStore }, { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession }] = await Promise.all([
			import(join(STOCK_NODE_MODULES!, "@earendil-works/pi-ai/dist/index.js")) as Promise<typeof import("@earendil-works/pi-ai")>,
			import(join(STOCK_NODE_MODULES!, "@earendil-works/pi-coding-agent/dist/index.js")) as Promise<typeof import("@earendil-works/pi-coding-agent")>,
		]);
		const credentials = new InMemoryCredentialStore();
		const setAccount = async (accountId: string): Promise<void> => {
			const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
			await credentials.modify("openai-codex", async () => ({ type: "oauth", access: `e30.${claims}.e30`, refresh: "not-used", expires: Date.now() + 3_600_000 }));
		};
		await setAccount("fixture-account");
		const { getAstraRecoveryToolDeclarations } = await import(join(scratch, "src/astra/tools.ts")) as typeof import("../src/astra/tools");
		const customTools = options.toolOverride ? getAstraRecoveryToolDeclarations().filter((tool) => tool.name === options.toolOverride).map((tool) => ({ ...tool, label: tool.name, async execute() { throw new Error("foreign recovery tool must not execute"); } })) : [];
		const manager = SessionManager.create(scratch, join(scratch, "sessions"));
		const start = async (sessionManager: SessionManager): Promise<AgentSession> => {
			const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
			const model = modelRuntime.getModel("openai-codex", "gpt-6-astra");
			if (!model) throw new Error("stock Astra model unavailable");
			contextWindow = model.contextWindow;
			const settingsManager = SettingsManager.inMemory(settings);
			const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, additionalExtensionPaths: [join(scratch, "extension.ts")], extensionFactories: laterExtension ? [laterExtension] : [], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await loader.reload();
			const { session, extensionsResult } = await createAgentSession({ cwd: scratch, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model, settingsManager, sessionManager, resourceLoader: loader, customTools, noTools: "builtin", sessionStartEvent: { type: "session_start", reason: sessions.length ? "resume" : "new" } });
			sessions.push(session);
			expect(extensionsResult.errors).toEqual([]);
			await session.bindExtensions({ onError: (error) => errors.push(error) });
			return session;
		};
		const session = await start(manager);
		expect(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === WINDOW_TYPE)).toHaveLength(1);
		await check({ session, manager, errors, requests, backendCalls, contextWindow, setAccount, restart: async () => {
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing persisted fixture session");
			session.dispose();
			return start(SessionManager.open(file));
		} });
	} finally {
		for (const session of sessions) session.dispose();
		globalThis.fetch = originalFetch;
		for (const key of envKeys) {
			if (oldEnv[key] === undefined) delete process.env[key];
			else process.env[key] = oldEnv[key];
		}
		await rm(scratch, { recursive: true, force: true });
	}
}

test.skipIf(!STOCK_NODE_MODULES)("stock final over-threshold response commits one remote boundary and resumes its window from JSONL", async () => {
	await withStockSession((request, contextWindow) => ({ tools: [], inputTokens: request === 1 ? Math.floor(contextWindow * 0.6) : 100 }), async ({ session, manager, errors, requests, restart }) => {
		await session.prompt("finish this task");
		const boundaries = manager.getBranch().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]?.details).toMatchObject({ protocol: 1, strategy: "astra-remote-window", window: { windowNumber: 1 } });
		expect(requests.map((request) => request.windowNumber)).toEqual([0]);
		expect(errors).toEqual([]);
		const resumed = await restart();
		await resumed.prompt("continue after restart");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 1]);
		expect(requests[1]?.windowId).not.toBe(requests[0]?.windowId);
		expect(resumed.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(errors).toEqual([]);
	});
});

test.skipIf(!STOCK_NODE_MODULES)("stock automatic tool continuation uses the committed next window and retains the exact tool pair", async () => {
	await withStockSession((request, contextWindow) => ({ tools: request === 1 ? ["get_context_remaining"] : [], inputTokens: request === 1 ? Math.floor(contextWindow * 0.6) : 100 }), async ({ session, manager, requests, errors }) => {
		await session.prompt("check the remaining context");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 1]);
		const boundaries = manager.getBranch().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		const retained = manager.buildSessionContext().messages;
		const assistant = retained.find((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"));
		const toolResult = retained.find((message) => message.role === "toolResult");
		expect(assistant?.role).toBe("assistant");
		expect(toolResult?.role).toBe("toolResult");
		if (assistant?.role !== "assistant" || toolResult?.role !== "toolResult") throw new Error("missing retained tool pair");
		expect(assistant.content.find((block) => block.type === "toolCall")?.id).toBe(toolResult.toolCallId);
		expect(errors).toEqual([]);
	});
});

test.skipIf(!STOCK_NODE_MODULES)("stock new_context commits after all tool results and keeps no previous conversational tail", async () => {
	await withStockSession((request) => ({ tools: request === 1 ? ["new_context", "get_context_remaining"] : [], inputTokens: 100 }), async ({ session, manager, requests, errors }) => {
		let receipt: unknown;
		let boundariesAtReceipt = -1;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "new_context") {
				receipt = event.result;
				boundariesAtReceipt = manager.getBranch().filter((entry) => entry.type === "compaction").length;
			}
		});
		await session.prompt("start a new context and check remaining tokens");
		unsubscribe();
		expect(boundariesAtReceipt).toBe(0);
		expect(receipt).toMatchObject({ details: { queued: true } });
		const branch = manager.getBranch();
		const boundaries = branch.filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		const boundary = boundaries[0]!;
		expect(boundary.firstKeptEntryId).toBe(boundary.id);
		const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(2);
		for (const result of results) expect(branch.indexOf(result)).toBeLessThan(branch.indexOf(boundary));
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 1]);
		expect(manager.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(errors).toEqual([]);
	});
});

test.skipIf(!STOCK_NODE_MODULES)("stock discarded new_context draft never advances the request window or survives settlement", async () => {
	await withStockSession((request) => ({ tools: request === 1 ? ["new_context"] : [], inputTokens: 100 }), async ({ session, manager, requests, errors }) => {
		await session.prompt("discard the proposed boundary");
		expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 0]);
		await session.prompt("no old pending transition");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 0, 0]);
		expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(errors).toEqual([]);
	}, (pi) => {
		pi.on("turn_end", (event) => ({ entries: event.entries.filter((entry) => entry.type !== "compaction") }));
	});
});

test.skipIf(!STOCK_NODE_MODULES)("stock duplicate new_context calls reject the second intent without creating two boundaries", async () => {
	await withStockSession((request) => ({ tools: request === 1 ? ["new_context", "new_context"] : [], inputTokens: 100 }), async ({ session, manager, requests, errors }) => {
		await session.prompt("request the same transition twice");
		const results = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.map((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError)).toEqual([false, true]);
		expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 1]);
		expect(errors).toEqual([]);
	});
});

for (const operation of ["retry", "history", "notes"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock ${operation} account change remains a hard error without another fetch or fallback`, async () => {
		let changeAccount: (() => Promise<void>) | undefined;
		await withStockSession(async () => {
			await changeAccount?.();
			if (operation === "retry") return new Response("controlled unavailable", { status: 503, headers: { "retry-after": "0" } });
			return { tools: [{ namespace: operation, name: operation === "history" ? "list_windows" : "write_file", arguments: operation === "history" ? {} : { path: "/checkpoint", text: "fixture checkpoint" } }], inputTokens: 100 };
		}, async ({ session, manager, requests, backendCalls, errors, setAccount }) => {
			changeAccount = () => setAccount("different-fixture-account");
			await session.prompt("account changes must not downgrade recovery");
			expect(requests).toHaveLength(1);
			expect(backendCalls).toHaveLength(0);
			expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "astra-remote-context-fallback")).toHaveLength(0);
			expect(session.state.errorMessage).toContain("different Codex account");
			expect(errors).toEqual([]);
		}, undefined, { providerRetries: operation === "retry" ? 1 : 0 });
	});
}

for (const queueKind of ["steer", "followUp"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock ${queueKind} input is delivered after the automatic window boundary`, async () => {
		let queue: (() => Promise<unknown>) | undefined;
		await withStockSession(async (request, contextWindow) => {
			if (request === 1) await queue?.();
			return { tools: [], inputTokens: request === 1 ? Math.floor(contextWindow * 0.6) : 100 };
		}, async ({ session, manager, requests, errors }) => {
			queue = () => session[queueKind]("preserve this queued user input");
			await session.prompt("finish the original task");
			expect(requests.map((request) => request.windowNumber)).toEqual([0, 1]);
			expect(JSON.stringify(requests[1]?.input)).toContain("preserve this queued user input");
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(errors).toEqual([]);
		});
	});
}

for (const namespace of ["history", "notes"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock ${namespace} encrypted receipt survives native tool execution and provider replay`, async () => {
		await withStockSession((request) => ({ tools: request === 1 ? [{ namespace, name: namespace === "history" ? "list_windows" : "write_file", arguments: namespace === "history" ? {} : { path: "/checkpoint", text: "fixture checkpoint" } }] : [], inputTokens: 100 }), async ({ session, requests, backendCalls, errors }) => {
			await session.prompt("recover encrypted context");
			expect(backendCalls).toHaveLength(1);
			expect(requests.map((request) => request.windowNumber)).toEqual([0, 0]);
			const outputs = requests[1]?.input.filter((item) => item.type === "function_call_output");
			expect(outputs).toHaveLength(1);
			expect(outputs?.[0]?.output).toEqual([{ type: "encrypted_content", encrypted_content: "fixture-ciphertext" }]);
			expect(JSON.stringify(requests[1]?.input)).not.toContain("must-not-leak");
			expect(errors).toEqual([]);
		}, undefined, { backendReply: () => Response.json({ encrypted_output: "fixture-ciphertext", text: "must-not-leak" }) });
	});
}

test.skipIf(!STOCK_NODE_MODULES)("stock remote generation disables native fetch redirects", async () => {
	await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, requests, errors }) => {
		await session.prompt("guard the native fetch boundary");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.redirect).toBe("error");
		expect(errors).toEqual([]);
	});
});

for (const toolOverride of ["history", "notes"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock rejects foreign ${toolOverride} ownership even when its declaration is identical`, async () => {
		await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, requests, errors }) => {
			await session.prompt("a matching schema is not tool ownership");
			expect(requests).toHaveLength(0);
			expect(session.state.errorMessage).toContain("owned history and notes tools");
			expect(errors.every((error) => error.error.includes("owned history and notes tools"))).toBe(true);
		}, undefined, { toolOverride });
	});
}

for (const mode of ["remote", "invalid"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock switch away from Astra ignores ${mode} Astra mode state`, async () => {
		await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, requests, errors }) => {
			await session.prompt("persist a remote Astra turn");
			process.env.PI_ASTRA_COMPACTION_MODE = mode;
			const ordinary = session.modelRuntime.getModel("openai-codex", "gpt-5.6-terra");
			if (!ordinary) throw new Error("stock ordinary model unavailable");
			await session.setModel(ordinary);
			await session.prompt("ordinary models must remain ordinary");
			expect(requests.map((request) => request.windowNumber)).toEqual([0, undefined]);
			expect(session.getActiveToolNames()).not.toContain("history");
			expect(errors).toEqual([]);
		});
	});
}

test.skipIf(!STOCK_NODE_MODULES)("stock environment default is not persisted and a resumed session follows the changed default", async () => {
	await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, manager, requests, errors, restart }) => {
		await session.prompt("persist the environment-selected session");
		expect(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "astra-remote-context-mode")).toHaveLength(0);
		process.env.PI_ASTRA_COMPACTION_MODE = "summary";
		const resumed = await restart();
		expect(resumed.getActiveToolNames()).not.toContain("history");
		await resumed.prompt("ordinary native dispatch after restart");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, undefined]);
		expect(errors).toEqual([]);
	});
});

test.skipIf(!STOCK_NODE_MODULES)("stock slash selection is versioned, survives restart, overrides the default and is not duplicated at startup", async () => {
	await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, manager, requests, errors, restart }) => {
		await session.prompt("persist the session");
		await session.prompt("/astra remote");
		await session.bindExtensions({});
		await session.bindExtensions({});
		process.env.PI_ASTRA_COMPACTION_MODE = "invalid-default";
		const resumed = await restart();
		await resumed.prompt("the explicit choice takes precedence");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 0]);
		const choices = resumed.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "astra-remote-context-mode");
		expect(choices).toHaveLength(1);
		expect(choices[0]).toMatchObject({ data: { protocol: 1, mode: "remote" } });
		expect(manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === WINDOW_TYPE)).toHaveLength(1);
		await resumed.prompt("/astra summary");
		expect(resumed.getActiveToolNames()).not.toContain("history");
		await resumed.prompt("the explicit summary choice takes precedence too");
		expect(requests.map((request) => request.windowNumber)).toEqual([0, 0, undefined]);
		expect(errors).toEqual([]);
	});
});

for (const invalidState of ["environment", "persisted"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock malformed ${invalidState} mode is diagnosed without dispatch or a fallback choice`, async () => {
		await withStockSession(() => ({ tools: [], inputTokens: 100 }), async ({ session, manager, requests, errors }) => {
			if (invalidState === "environment") process.env.PI_ASTRA_COMPACTION_MODE = "invalid";
			else manager.appendCustomEntry("astra-remote-context-mode", { protocol: 999, mode: "remote" });
			await session.bindExtensions({});
			expect(errors.some((error) => error.event === "session_start")).toBe(true);
			await session.prompt("malformed mode must not dispatch");
			expect(requests).toHaveLength(0);
			expect(manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "astra-remote-context-fallback")).toHaveLength(0);
		});
	});
}

for (const namespace of ["history", "notes"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock fallback disables ${namespace} before immediate continuation and rejects a repeated operation`, async () => {
		let activeTools: (() => string[]) | undefined;
		let continuationTools: string[] = [];
		await withStockSession((request) => {
			if (request === 2) continuationTools = activeTools?.() ?? [];
			const arguments_ = namespace === "history" ? {} : { path: "/checkpoint", text: "fixture checkpoint" };
			return { tools: request < 3 ? [{ namespace, name: request === 1 ? namespace === "history" ? "list_windows" : "write_file" : namespace, arguments: request === 1 ? arguments_ : { ...arguments_, action: namespace === "history" ? "list_windows" : "write_file" } }] : [], inputTokens: 100 };
		}, async ({ session, requests, backendCalls, errors }) => {
			activeTools = () => session.getActiveToolNames();
			await session.prompt("a fallback must fence the next recovery call");
			expect(backendCalls).toHaveLength(1);
			expect(continuationTools).not.toContain("history");
			expect(continuationTools).not.toContain("notes");
			expect(continuationTools).not.toContain("new_context");
			expect(continuationTools).not.toContain("get_context_remaining");
			expect(requests.map((request) => request.windowNumber)).toEqual([0, undefined, undefined]);
			expect(requests[1]?.tools).toEqual([]);
			expect(errors).toEqual([]);
		}, undefined, { backendReply: () => new Response("controlled unavailable", { status: 503 }) });
	});

	for (const status of [503, 429, 401, "abort", "timeout", "redirect", "malformed"] as const) {
		test.skipIf(!STOCK_NODE_MODULES)(`stock ${namespace} terminal ${status} falls back once only when eligible and never replays the operation`, async () => {
			let abort: (() => void) | undefined;
			await withStockSession((request) => ({ tools: request === 1 ? [{ namespace, name: namespace === "history" ? "list_windows" : "write_file", arguments: namespace === "history" ? {} : { path: "/checkpoint", text: "fixture checkpoint" } }] : [], inputTokens: 100 }), async ({ session, manager, backendCalls, requests, errors }) => {
				abort = () => { void session.abort(); };
				await session.prompt("use the remote recovery tool");
				const eligible = status === 503 || status === 429;
				expect(backendCalls).toHaveLength(1);
				expect(requests.map((request) => request.windowNumber)).toEqual(status === "abort" ? [0] : [0, eligible ? undefined : 0]);
				const fallback = manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "astra-remote-context-fallback");
				expect(fallback).toHaveLength(eligible ? 1 : 0);
				if (eligible) {
					expect(fallback[0]).toMatchObject({ display: true, details: { status } });
					expect(session.getActiveToolNames()).not.toContain("history");
					expect(session.getActiveToolNames()).not.toContain("notes");
				}
				expect(errors).toEqual([]);
			}, undefined, { backendReply: () => {
				if (status === "abort") {
					queueMicrotask(() => abort?.());
					return new Response("cancelled service response", { status: 503 });
				}
				if (status === "timeout") throw new DOMException("controlled backend timeout", "TimeoutError");
				if (status === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/denied" } });
				if (status === "malformed") return Response.json({ encrypted_output: "" });
				return new Response("controlled service status", { status });
			} });
		});
	}
}

for (const mutation of ["discard", "corrupt"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock fallback ${mutation} by a later boundary hook stays quarantined`, async () => {
		await withStockSession(() => ({ tools: [{ namespace: "notes", name: "write_file", arguments: { path: "/checkpoint", text: "fixture checkpoint" } }], inputTokens: 100 }), async ({ session, requests, backendCalls }) => {
			await session.prompt("an uncommitted fallback must not reopen remote dispatch");
			expect(requests).toHaveLength(1);
			expect(backendCalls).toHaveLength(1);
			expect(session.state.errorMessage).toContain(mutation === "discard" ? "owned history and notes tools" : "malformed persisted Astra mode");
			expect(session.getActiveToolNames()).not.toContain("notes");
			await session.prompt("do not reopen remote dispatch on the next prompt either");
			expect(requests).toHaveLength(1);
			expect(backendCalls).toHaveLength(1);
		}, (pi) => {
			const mutate = (event: { readonly entries: readonly import("@earendil-works/pi-coding-agent").SessionBoundaryDraft[] }) => ({ entries: event.entries.flatMap((entry) => {
				if (entry.type === "custom" && entry.customType === "astra-remote-context-mode") return mutation === "discard" ? [] : [{ ...entry, data: { protocol: 999, mode: "summary" } }];
				if (mutation === "discard" && entry.type === "custom_message" && entry.customType === "astra-remote-context-fallback") return [];
				return [entry];
			}) });
			pi.on("turn_end", mutate);
			pi.on("agent_before_settle", mutate);
		}, { backendReply: () => new Response("controlled unavailable", { status: 503 }) });
	});
}

for (const terminal of [401, 503, 429, "provider-error", "abort", "redirect"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock terminal ${terminal} after 503 only falls back for a terminal eligible HTTP status`, async () => {
		let abort: (() => void) | undefined;
		await withStockSession((request) => {
			if (request === 1) {
				if (terminal === "abort") queueMicrotask(() => abort?.());
				return new Response("controlled unavailable", { status: 503, headers: { "retry-after": "0" } });
			}
			if (terminal === "provider-error") return new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"fixture_failure","message":"controlled provider failure"}}}\n\n', { headers: { "content-type": "text/event-stream" } });
			if (terminal === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/denied" } });
			return new Response("controlled terminal status", { status: typeof terminal === "number" ? terminal : 400 });
		}, async ({ session, manager, requests, errors }) => {
			abort = () => { void session.abort(); };
			await session.prompt("exercise the native retry terminal outcome");
			const eligible = terminal === 503 || terminal === 429;
			const fallback = manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "astra-remote-context-fallback");
			expect(requests).toHaveLength(terminal === "abort" ? 1 : 2);
			expect(fallback).toHaveLength(eligible ? 1 : 0);
			const choices = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "astra-remote-context-mode");
			expect(choices).toHaveLength(eligible ? 1 : 0);
			if (eligible) expect(choices[0]).toMatchObject({ data: { protocol: 1, mode: "summary", status: terminal } });
			expect(errors).toEqual([]);
		}, undefined, { providerRetries: 1 });
	});
}

for (const mutation of ["delete", "replace", "reorder"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock provider rejects a later context hook attempting to ${mutation} retained tool context`, async () => {
		await withStockSession((request) => ({ tools: request === 1 ? ["get_context_remaining"] : [], inputTokens: 100 }), async ({ session, requests, errors }) => {
			await session.prompt("preserve the actual tool result");
			expect(requests).toHaveLength(1);
			expect(session.state.errorMessage).toContain("retained task or tool context");
			expect(errors).toEqual([]);
		}, (pi) => {
			pi.on("context", (event) => {
				const index = event.messages.findIndex((message) => message.role === "toolResult");
				if (index < 0) return undefined;
				const messages = [...event.messages];
				const message = messages[index]!;
				if (mutation === "delete") messages.splice(index, 1);
				if (mutation === "replace" && message.role === "toolResult") messages[index] = { ...message, content: [{ type: "text", text: "forged result" }] };
				if (mutation === "reorder") {
					messages.splice(index, 1);
					messages.unshift(message);
				}
				return { messages };
			});
		});
	});
}

for (const tool of ["new_context", "get_context_remaining"]) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock cancellation after ${tool} does not commit or leak a window transition`, async () => {
		await withStockSession((request, contextWindow) => ({ tools: request === 1 ? [tool] : [], inputTokens: request === 1 ? Math.floor(contextWindow * 0.6) : 100 }), async ({ session, manager, requests, errors }) => {
			let aborted = false;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolName === tool) {
					aborted = true;
					void session.abort();
				}
			});
			await session.prompt("cancel after the tool finishes");
			unsubscribe();
			expect(aborted).toBe(true);
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			await session.prompt("continue without the cancelled transition");
			expect(requests.map((request) => request.windowNumber)).toEqual([0, 0]);
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(errors).toEqual([]);
		});
	});
}
