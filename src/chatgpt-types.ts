export interface ChatGptRequest {
	readonly id: string;
	readonly prompt: string;
	readonly kind: "history" | "turn-prefix";
}

/** External UI boundary; implementations must reject unusable or partial summaries. */
export interface ChatGptTransport {
	complete(request: ChatGptRequest, signal: AbortSignal): Promise<string>;
}
