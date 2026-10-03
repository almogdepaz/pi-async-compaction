import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { AstraCodexAuth } from "../src/astra/auth";

const STOCK_NODE_MODULES = process.env.PI_ASTRA_HOST_NODE_MODULES;

for (const profile of ["stream", "streamSimple"] as const) {
	test.skipIf(!STOCK_NODE_MODULES)(`stock ${profile} abort during deferred auth never dispatches or queues fallback`, async () => {
		const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-abort-"));
		try {
			await cp(join(import.meta.dir, "..", "src"), join(scratch, "src"), { recursive: true });
			await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
			const [{ openaiCodexProvider }, { createAstraCodexProvider }, { getAstraRecoveryToolDeclarations }, { normalizeContext }] = await Promise.all([
				import(pathToFileURL(join(STOCK_NODE_MODULES!, "@earendil-works/pi-ai/dist/providers/openai-codex.js")).href) as Promise<{ openaiCodexProvider: () => Provider<"openai-codex-responses"> }>,
				import(pathToFileURL(join(scratch, "src/astra/provider.ts")).href) as Promise<typeof import("../src/astra/provider")>,
				import(pathToFileURL(join(scratch, "src/astra/tools.ts")).href) as Promise<typeof import("../src/astra/tools")>,
				import(pathToFileURL(join(STOCK_NODE_MODULES!, "@earendil-works/pi-ai/dist/utils/transcript.js")).href) as Promise<typeof import("@earendil-works/pi-ai/utils/transcript")>,
			]);
			const native = openaiCodexProvider();
			const model = native.getModels().find((candidate) => candidate.id === "gpt-6-astra");
			if (!model) throw new Error("stock Astra model unavailable");
			const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" }, exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.e30`;
			const controller = new AbortController();
			const entered = Promise.withResolvers<void>();
			const auth = Promise.withResolvers<AstraCodexAuth>();
			let fetchCalls = 0;
			const fallbacks: number[] = [];
			const provider = createAstraCodexProvider(native, () => ({ kind: "required", leafId: "leaf", window: { sessionId: "session", firstWindowId: "window", currentWindowId: "window", windowNumber: 0, accountId: "account-1" } }), async () => {
				entered.resolve();
				return auth.promise;
			}, (status) => fallbacks.push(status));
			const context = normalizeContext({ systemPrompt: "fixture", tools: [...getAstraRecoveryToolDeclarations()], messages: [
				{ role: "user", content: "abort before dispatch", timestamp: 0 },
			] });
			const stream = provider[profile](model, context, {
				sessionId: "session", signal: controller.signal, apiKey: token, headers: { "chatgpt-account-id": "account-1" }, maxRetries: 0,
				// Intentionally ignores the signal: the wrapper must fence dispatch itself.
				fetch: (async (_input, _init) => { fetchCalls++; return new Response("controlled unavailable", { status: 503 }); }) as typeof fetch,
			});
			await Promise.race([entered.promise, stream.result().then((response) => { throw new Error(`stream ended before deferred auth: ${response.errorMessage}`); })]);
			controller.abort();
			auth.resolve({ accountId: "account-1", authorization: `Bearer ${token}` });
			const response = await stream.result();
			expect(fetchCalls).toBe(0);
			expect(response.stopReason).toBe("aborted");
			expect(fallbacks).toEqual([]);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
}
