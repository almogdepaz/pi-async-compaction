import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";
import type { Provider } from "@earendil-works/pi-ai";

const STOCK_NODE_MODULES = process.env.PI_ASTRA_HOST_NODE_MODULES;
const STOCK_AI_INDEX = STOCK_NODE_MODULES && join(STOCK_NODE_MODULES, "@earendil-works", "pi-ai", "dist", "index.js");
const STOCK_CODEX_PROVIDER = STOCK_NODE_MODULES && join(STOCK_NODE_MODULES, "@earendil-works", "pi-ai", "dist", "providers", "openai-codex.js");
function accessToken(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
		exp: Math.floor(Date.now() / 1_000) + 3_600,
	})).toString("base64url");
	return `e30.${payload}.e30`;
}

interface StockAi {
	readonly InMemoryCredentialStore: new () => {
		modify: (providerId: string, update: () => Promise<unknown>) => Promise<unknown>;
	};
	readonly createModels: (options: { readonly credentials: unknown }) => {
		setProvider: (provider: unknown) => void;
		getAuth: (providerId: string) => Promise<{ readonly auth: { readonly apiKey?: string; readonly headers?: Record<string, string> } } | undefined>;
	};
}

interface StockCodexProvider {
	readonly openaiCodexProvider: () => Provider<"openai-codex-responses">;
}

test.skipIf(!STOCK_NODE_MODULES)("stock native OAuth derives the Astra account header without refresh or network access", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "pi-astra-stock-auth-"));
	const source = join(import.meta.dir, "..", "src", "astra", "auth.ts");
	const access = accessToken();
	const copiedSource = join(scratch, "auth.ts");
	const originalFetch = globalThis.fetch;
	try {
		await cp(source, copiedSource);
		await symlink(STOCK_NODE_MODULES!, join(scratch, "node_modules"));
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			throw new Error("unexpected OAuth or backend network request");
		}) as typeof fetch;

		const [{ InMemoryCredentialStore, createModels }, { openaiCodexProvider }, astraAuth] = await Promise.all([
			import(pathToFileURL(STOCK_AI_INDEX!).href) as Promise<StockAi>,
			import(pathToFileURL(STOCK_CODEX_PROVIDER!).href) as Promise<StockCodexProvider>,
			import(`${pathToFileURL(copiedSource).href}?cache=${Date.now()}`) as Promise<typeof import("../src/astra/auth")>,
		]);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai-codex", async () => ({
			type: "oauth",
			access,
			refresh: "not-used",
			expires: Date.now() + 60 * 60_000,
		}));
		const models = createModels({ credentials });
		const wrapped = astraAuth.wrapNativeCodexOAuthForAstra(openaiCodexProvider());
		models.setProvider(wrapped);

		const resolved = await models.getAuth("openai-codex");
		expect(resolved?.auth.apiKey).toBe(access);
		expect(resolved?.auth.headers?.["chatgpt-account-id"]).toBe("account-1");
		await expect(wrapped.auth.oauth?.toAuth({
			type: "oauth",
			access,
			refresh: "not-used",
			expires: Date.now() + 60 * 60_000,
			accountId: "another-account",
		} as never)).rejects.toThrow("contradictory Codex account metadata");
	} finally {
		globalThis.fetch = originalFetch;
		await rm(scratch, { recursive: true, force: true });
	}
});
