import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface AstraCodexAuth {
	readonly accountId: string;
	readonly authorization: string;
}

/**
 * Resolves host-owned Codex OAuth material before model and request headers can
 * merge user configuration over it. Astra never parses credential storage.
 */
export async function resolveAstraCodexAuth(ctx: ExtensionContext): Promise<AstraCodexAuth> {
	const resolution = await ctx.modelRegistry.getProviderAuth("openai-codex");
	if (!resolution) throw new Error("Astra remote context could not resolve Codex authentication");

	const headers = new Headers();
	for (const [name, value] of Object.entries(resolution.auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	const accountId = headers.get("chatgpt-account-id");
	const authorization = headers.get("authorization") ?? (resolution.auth.apiKey ? `Bearer ${resolution.auth.apiKey}` : null);
	if (!accountId || !authorization) {
		throw new Error("Astra remote context requires Codex subscription authentication and account metadata");
	}
	return { accountId, authorization };
}
