export interface ChatGptRequest {
	readonly id: string;
	readonly prompt: string;
	readonly kind: "history" | "turn-prefix";
}

/** External UI boundary; implementations must reject unusable or partial summaries. */
export interface ChatGptTransport {
	complete(request: ChatGptRequest, signal: AbortSignal): Promise<string>;
}

export const CHATGPT_ORIGIN = "https://chatgpt.com";

/** Returns the normalized account id from ChatGPT's structured session response. */
export function getChatGptAccountId(session: unknown): string | undefined {
	if (!session || typeof session !== "object") return undefined;
	const user = (session as { readonly user?: unknown }).user;
	if (!user || typeof user !== "object") return undefined;
	const id = (user as { readonly id?: unknown }).id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

export interface ChatGptWebLoginInput {
	readonly url: string;
	readonly profileDir: string;
	readonly braveExecutablePath: string;
	readonly timeoutMs: number;
	readonly pollIntervalMs: number;
	readonly headless: false;
	/** Optional caller-owned confirmation boundary for direct interactive login. */
	readonly confirm?: (signal: AbortSignal) => Promise<boolean>;
}

export interface ChatGptWebCompletionInput {
	readonly url: string;
	readonly prompt: string;
	readonly expectedAccountHash: string;
	readonly profileDir: string;
	readonly braveExecutablePath: string;
	readonly timeoutMs: number;
	readonly pollIntervalMs: number;
	readonly headless: true;
}

/** Browser boundary; production owns one isolated persistent Brave profile. */
export interface ChatGptWebAutomation {
	login(input: ChatGptWebLoginInput, signal: AbortSignal): Promise<{ readonly accountHash: string }>;
	complete(input: ChatGptWebCompletionInput, signal: AbortSignal): Promise<{ readonly markdownHtml: string }>;
}

export class ChatGptWebAuthenticationError extends Error {
	constructor(readonly reason: "account_changed" | "session_expired") {
		super(reason === "account_changed" ? "ChatGPT web account changed" : "ChatGPT web session expired");
		this.name = "ChatGptWebAuthenticationError";
	}
}
