import { expect, test } from "bun:test";
import { callAstraBackend } from "../src/astra/remote-client";
import type { AstraWindowIdentity } from "../src/astra/provider";

const context = {
	model: {
		provider: "openai-codex",
		id: "gpt-6-astra",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
	},
	modelRegistry: {
		getProviderAuth: async () => ({
			auth: { apiKey: "fresh-token", headers: { "chatgpt-account-id": "account-1" } },
		}),
		getApiKeyAndHeaders: async () => ({
			ok: true as const,
			apiKey: "stale-token",
			headers: { "chatgpt-account-id": "stale-account", authorization: "Bearer stale-token" },
		}),
	},
	sessionManager: { getSessionId: () => "session-1", getLeafId: () => null },
} as never;

const window = {
	sessionId: "session-1",
	firstWindowId: "window-1",
	currentWindowId: "window-1",
	windowNumber: 0,
	accountId: "account-1",
} as const;

test("uses the fixed Codex origin, rejects redirects, and preserves encrypted output", async () => {
	const originalFetch = globalThis.fetch;
	let request: Request | undefined;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);
			return new Response(JSON.stringify({ encrypted_output: "ciphertext" }), { status: 200 });
		}) as typeof fetch;
		const result = await callAstraBackend(
			context,
			"alpha/notes/v2/write_file",
			{ path: "state", text: "checkpoint" },
			undefined,
			{ mode: "tokens", limit: 10_000 },
			() => window,
		);
		expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/alpha/notes/v2/write_file");
		expect(request?.redirect).toBe("error");
		expect(request?.headers.get("x-openai-encrypted-tool-arguments")).toBe("true");
		expect(request?.headers.get("chatgpt-account-id")).toBe("account-1");
		expect(request?.headers.get("authorization")).toBe("Bearer fresh-token");
		expect(result).toEqual({ output: { encrypted_output: "ciphertext" }, images: [] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("uses a freshly resolved token when the bound Codex account is unchanged", async () => {
	const originalFetch = globalThis.fetch;
	let request: Request | undefined;
	try {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);
			return new Response(JSON.stringify({ encrypted_output: "fresh-ciphertext" }), { status: 200 });
		}) as typeof fetch;
		const refreshedAuthContext = {
			...(context as Record<string, unknown>),
			modelRegistry: {
				getProviderAuth: async () => ({
					auth: { apiKey: "refreshed-token", headers: { "chatgpt-account-id": "account-1" } },
				}),
			},
		};
		await expect(callAstraBackend(
			refreshedAuthContext as never,
			"alpha/notes/v2/write_file",
			{ path: "state", text: "checkpoint" },
			undefined,
			{ mode: "tokens", limit: 10_000 },
			() => window,
		)).resolves.toMatchObject({ output: { encrypted_output: "fresh-ciphertext" } });
		expect(request?.headers.get("authorization")).toBe("Bearer refreshed-token");
		expect(request?.headers.get("chatgpt-account-id")).toBe("account-1");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fails closed when host provider auth changes account before a remote tool fetch", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	const fetchMock = async (_input: RequestInfo | URL, _init?: RequestInit) => {
		fetchCalls += 1;
		return new Response("unexpected", { status: 200 });
	};
	try {
		globalThis.fetch = fetchMock as typeof fetch;
		const changedAccountContext = {
			...(context as Record<string, unknown>),
			modelRegistry: {
				getProviderAuth: async () => ({
					auth: { apiKey: "new-token", headers: { "chatgpt-account-id": "account-2" } },
				}),
			},
		};
		await expect(callAstraBackend(
			changedAccountContext as never,
			"alpha/notes/v2/write_file",
			{ path: "state", text: "checkpoint" },
			undefined,
			{ mode: "tokens", limit: 10_000 },
			() => window,
		)).rejects.toThrow("different Codex account");
		expect(fetchCalls).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects a window change that races provider authentication before fetch", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	let resolveAuth: ((value: { auth: { apiKey: string; headers: { "chatgpt-account-id": string } } }) => void) | undefined;
	let currentWindow: AstraWindowIdentity = window;
	try {
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
			fetchCalls += 1;
			return new Response("unexpected", { status: 200 });
		}) as typeof fetch;
		const delayedContext = {
			...(context as Record<string, unknown>),
			modelRegistry: {
				getProviderAuth: () => new Promise<{ auth: { apiKey: string; headers: { "chatgpt-account-id": string } } }>((resolve) => { resolveAuth = resolve; }),
			},
		};
		const request = callAstraBackend(delayedContext as never, "alpha/notes/v2/write_file", { path: "state", text: "checkpoint" }, undefined, { mode: "tokens", limit: 10_000 }, () => currentWindow);
		currentWindow = { ...window, currentWindowId: "window-2", previousWindowId: "window-1", windowNumber: 1 };
		resolveAuth?.({ auth: { apiKey: "fresh-token", headers: { "chatgpt-account-id": "account-1" } } });
		await expect(request).rejects.toThrow("changed while authentication was resolving");
		expect(fetchCalls).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("preserves a valid bounded PNG image", async () => {
	const originalFetch = globalThis.fetch;
	try {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ images: [{ data: png, mime_type: "image/png" }] }), { status: 200 })) as typeof fetch;
		await expect(callAstraBackend(context, "alpha/history/v2/read_item", { item_id: "item", window_id: "window" }, undefined, { mode: "tokens", limit: 10_000 }, () => window)).resolves.toMatchObject({ images: [{ type: "image", mimeType: "image/png", data: png }] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects an unsupported image MIME type before tool success", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ images: [{ data: "aGVsbG8=", mime_type: "image/svg+xml" }] }), { status: 200 })) as typeof fetch;
		await expect(callAstraBackend(context, "alpha/history/v2/read_item", { item_id: "item", window_id: "window" }, undefined, { mode: "tokens", limit: 10_000 }, () => window)).rejects.toThrow("invalid image content");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects malformed backend image data before tool success", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ images: [{ data: "not base64!", mime_type: "image/png" }] }), { status: 200 })) as typeof fetch;
		await expect(callAstraBackend(
			context,
			"alpha/history/v2/read_item",
			{ item_id: "item", window_id: "window" },
			undefined,
			{ mode: "tokens", limit: 10_000 },
			() => window,
		)).rejects.toThrow("invalid image content");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects an empty encrypted backend result before tool success", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ encrypted_output: "" }), { status: 200 })) as typeof fetch;
		await expect(callAstraBackend(
			context,
			"alpha/notes/v2/write_file",
			{ path: "state", text: "checkpoint" },
			undefined,
			{ mode: "tokens", limit: 10_000 },
			() => window,
		)).rejects.toThrow("invalid encrypted output");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
