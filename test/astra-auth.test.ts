import { expect, test } from "bun:test";
import * as astraAuth from "../src/astra/auth";

const ACCESS_TOKEN = "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjb3VudC0xIn19.e30";

function nativeProvider(): Record<string, unknown> {
	return {
		id: "openai-codex",
		auth: {
			oauth: {
				name: "native Codex OAuth",
				login: async () => ({ type: "oauth", access: ACCESS_TOKEN, refresh: "unused", expires: Date.now() + 60_000 }),
				refresh: async () => ({ type: "oauth", access: ACCESS_TOKEN, refresh: "unused", expires: Date.now() + 60_000 }),
				toAuth: async (credential: { readonly access: string }) => ({ apiKey: credential.access }),
			},
		},
	};
}

test("wraps native Codex OAuth before activation can resolve the account header", async () => {
	const wrapNativeCodexOAuthForAstra = (astraAuth as Record<string, unknown>).wrapNativeCodexOAuthForAstra;
	expect(typeof wrapNativeCodexOAuthForAstra).toBe("function");
	if (typeof wrapNativeCodexOAuthForAstra !== "function") return;

	const wrapped = wrapNativeCodexOAuthForAstra(nativeProvider()) as {
		readonly auth: { readonly oauth: { readonly toAuth: (credential: { readonly access: string }) => Promise<{ readonly headers?: Record<string, string>; readonly apiKey?: string }> } };
	};
	const auth = await wrapped.auth.oauth.toAuth({ access: ACCESS_TOKEN });
	expect(auth.apiKey).toBe(ACCESS_TOKEN);
	expect(auth.headers?.["chatgpt-account-id"]).toBe("account-1");
});

test("permits missing legacy credential account metadata but rejects malformed or contradictory stored account metadata", async () => {
	const wrapNativeCodexOAuthForAstra = (astraAuth as Record<string, unknown>).wrapNativeCodexOAuthForAstra;
	expect(typeof wrapNativeCodexOAuthForAstra).toBe("function");
	if (typeof wrapNativeCodexOAuthForAstra !== "function") return;

	const wrapped = wrapNativeCodexOAuthForAstra(nativeProvider()) as {
		readonly auth: { readonly oauth: { readonly toAuth: (credential: { readonly access: string; readonly accountId?: unknown }) => Promise<unknown> } };
	};
	await expect(wrapped.auth.oauth.toAuth({ access: ACCESS_TOKEN })).resolves.toBeDefined();
	await expect(wrapped.auth.oauth.toAuth({ access: ACCESS_TOKEN, accountId: 7 })).rejects.toThrow("malformed Codex account metadata");
	await expect(wrapped.auth.oauth.toAuth({ access: ACCESS_TOKEN, accountId: "another-account" })).rejects.toThrow("contradictory Codex account metadata");
});

test("rejects malformed bearer or returned-header Codex account metadata", async () => {
	const wrapNativeCodexOAuthForAstra = (astraAuth as Record<string, unknown>).wrapNativeCodexOAuthForAstra;
	expect(typeof wrapNativeCodexOAuthForAstra).toBe("function");
	if (typeof wrapNativeCodexOAuthForAstra !== "function") return;

	const malformed = wrapNativeCodexOAuthForAstra(nativeProvider()) as {
		readonly auth: { readonly oauth: { readonly toAuth: (credential: { readonly access: string }) => Promise<unknown> } };
	};
	await expect(malformed.auth.oauth.toAuth({ access: "not-a-jwt" })).rejects.toThrow("Codex account metadata");

	const contradictory = nativeProvider() as {
		auth: { oauth: { toAuth: (credential: { readonly access: string }) => Promise<{ readonly apiKey: string; readonly headers: Record<string, string> }> } };
	};
	contradictory.auth.oauth.toAuth = async (credential) => ({
		apiKey: credential.access,
		headers: { "chatgpt-account-id": "another-account" },
	});
	const wrapped = wrapNativeCodexOAuthForAstra(contradictory) as {
		readonly auth: { readonly oauth: { readonly toAuth: (credential: { readonly access: string }) => Promise<unknown> } };
	};
	await expect(wrapped.auth.oauth.toAuth({ access: ACCESS_TOKEN })).rejects.toThrow("contradictory Codex account metadata");
});
