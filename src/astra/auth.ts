import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const CODEX_ACCOUNT_HEADER = "chatgpt-account-id";
const MAX_JWT_PAYLOAD_BYTES = 8_192;
const MAX_ACCOUNT_ID_LENGTH = 512;

type CodexOAuth = NonNullable<Provider["auth"]["oauth"]>;
type CodexCredential = Parameters<CodexOAuth["toAuth"]>[0];
type CodexModelAuth = Awaited<ReturnType<CodexOAuth["toAuth"]>>;

export interface AstraCodexAuth {
	readonly accountId: string;
	readonly authorization: string;
}

/**
 * Resolves host-owned Codex OAuth material before model and request headers can
 * merge user configuration over it. Astra never parses credential storage.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateCodexAccountId(accountId: unknown): string {
	if (
		typeof accountId !== "string" ||
		accountId.length === 0 ||
		accountId.length > MAX_ACCOUNT_ID_LENGTH ||
		accountId.trim() !== accountId ||
		/[\u0000-\u001f\u007f]/.test(accountId)
	) {
		throw new Error("Astra remote context has malformed Codex account metadata");
	}
	return accountId;
}

function accountIdFromCodexAccessToken(accessToken: string): string {
	const segments = accessToken.split(".");
	const payload = segments[1];
	if (segments.length !== 3 || !payload || payload.length > MAX_JWT_PAYLOAD_BYTES || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) {
		throw new Error("Astra remote context has malformed Codex account metadata");
	}
	let claims: unknown;
	try {
		const padding = "=".repeat((4 - payload.length % 4) % 4);
		claims = JSON.parse(Buffer.from(`${payload.replace(/-/g, "+").replace(/_/g, "/")}${padding}`, "base64").toString("utf8"));
	} catch {
		throw new Error("Astra remote context has malformed Codex account metadata");
	}
	const accountId = isRecord(claims) && isRecord(claims[CODEX_ACCOUNT_CLAIM])
		? claims[CODEX_ACCOUNT_CLAIM]["chatgpt_account_id"]
		: undefined;
	return validateCodexAccountId(accountId);
}

function accountIdFromStoredCodexCredential(credential: CodexCredential): string | undefined {
	const stored = credential as unknown;
	if (!isRecord(stored) || !Object.hasOwn(stored, "accountId")) return undefined;
	return validateCodexAccountId(stored["accountId"]);
}

function withCodexAccountHeader(auth: CodexModelAuth, accountId: string): CodexModelAuth {
	const headers: Record<string, string | null> = {};
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (name.toLowerCase() === CODEX_ACCOUNT_HEADER) {
			if (value !== null && value !== accountId) throw new Error("Astra remote context has contradictory Codex account metadata");
			continue;
		}
		headers[name] = value;
	}
	return { ...auth, headers: { ...headers, [CODEX_ACCOUNT_HEADER]: accountId } };
}

/**
 * Keeps native Codex OAuth login/refresh while deriving the account header from
 * the credential at the public `toAuth` boundary.
 */
export function wrapNativeCodexOAuthForAstra(native: Provider): Provider {
	const oauth = native.auth.oauth;
	if (!oauth) throw new Error("Astra remote context requires native Codex OAuth");
	return {
		...native,
		auth: {
			...native.auth,
			oauth: {
				...oauth,
				async toAuth(credential: CodexCredential): Promise<CodexModelAuth> {
					const bearerAccountId = accountIdFromCodexAccessToken(credential.access);
					const storedAccountId = accountIdFromStoredCodexCredential(credential);
					if (storedAccountId !== undefined && storedAccountId !== bearerAccountId) {
						throw new Error("Astra remote context has contradictory Codex account metadata");
					}
					const auth = await oauth.toAuth(credential);
					return withCodexAccountHeader(auth, bearerAccountId);
				},
			},
		},
	};
}

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
