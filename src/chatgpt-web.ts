import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import TurndownService from "turndown";
import { createPlaywrightChatGptAutomation, getChatGptResponseFailure } from "./chatgpt-brave";
import { CHATGPT_ORIGIN, ChatGptWebAuthenticationError, getChatGptAccountId } from "./chatgpt-types";
import type {
	ChatGptRequest,
	ChatGptTransport,
	ChatGptWebAutomation,
} from "./chatgpt-types";

export { createPlaywrightChatGptAutomation, getChatGptResponseFailure } from "./chatgpt-brave";
export { CHATGPT_ORIGIN, ChatGptWebAuthenticationError } from "./chatgpt-types";
export type { ChatGptWebAutomation } from "./chatgpt-types";

const CHATGPT_URL = `${CHATGPT_ORIGIN}/`;
const BRAVE_EXECUTABLE_PATH = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const READINESS_MARKER_FILENAME = ".pi-compaction-ready.json";
const MARKER_VERSION = 3;

interface ChatGptReadiness {
	readonly accountHash: string;
}

export interface ChatGptWebConfig {
	readonly stateDir: string;
	readonly profileDir: string;
	readonly braveExecutablePath: string;
	readonly url: string;
	readonly responseTimeoutMs: number;
	readonly loginTimeoutMs: number;
	readonly pollIntervalMs: number;
}

export interface ChatGptWebDependencies {
	readonly config?: ChatGptWebConfig;
	readonly automation?: ChatGptWebAutomation;
	/** Optional Pi-facing confirmation; programmatic callers fall back to natural process exit. */
	readonly confirmLogin?: (signal: AbortSignal) => Promise<boolean>;
}

function positiveIntegerEnv(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getConfig(): ChatGptWebConfig {
	const stateDir = process.env.PI_ASYNC_PREFIX_COMPACTION_CHATGPT_STATE_DIR
		?? join(homedir(), ".pi", "chatgpt-web-compaction");
	return {
		stateDir,
		profileDir: join(stateDir, "brave-profile"),
		braveExecutablePath: BRAVE_EXECUTABLE_PATH,
		url: process.env.PI_ASYNC_PREFIX_COMPACTION_CHATGPT_URL ?? CHATGPT_URL,
		responseTimeoutMs: positiveIntegerEnv(
			"PI_ASYNC_PREFIX_COMPACTION_CHATGPT_RESPONSE_TIMEOUT_MS",
			DEFAULT_RESPONSE_TIMEOUT_MS,
		),
		loginTimeoutMs: positiveIntegerEnv(
			"PI_ASYNC_PREFIX_COMPACTION_CHATGPT_LOGIN_TIMEOUT_MS",
			DEFAULT_LOGIN_TIMEOUT_MS,
		),
		pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
	};
}

function abortError(): Error {
	const error = new Error("ChatGPT request aborted");
	error.name = "AbortError";
	return error;
}

const automationTails = new Map<string, Promise<void>>();

function waitForAutomationTurn(turn: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		void turn.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

async function runSerialized<TResult>(
	key: string,
	signal: AbortSignal,
	operation: () => Promise<TResult>,
): Promise<TResult> {
	const previous = automationTails.get(key) ?? Promise.resolve();
	let release: (() => void) | undefined;
	const completed = new Promise<void>((resolve) => { release = resolve; });
	const turn = previous.then(() => completed);
	automationTails.set(key, turn);
	void turn.then(() => {
		if (automationTails.get(key) === turn) automationTails.delete(key);
	});
	try {
		await waitForAutomationTurn(previous, signal);
		if (signal.aborted) throw abortError();
		return await operation();
	} finally {
		release?.();
	}
}

/** Serializes dedicated-profile browser ownership while allowing aborted waiters to leave the queue. */
export function serializeChatGptTransportByProfile(key: string, transport: ChatGptTransport): ChatGptTransport {
	return {
		complete: (request, signal) => runSerialized(key, signal, () => transport.complete(request, signal)),
	};
}

/** Validates the minimal account shape returned by ChatGPT's same-origin session endpoint. */
export function hasAuthenticatedChatGptSession(session: unknown): boolean {
	return getChatGptAccountId(session) !== undefined;
}

export function extractCompletedAssistantResponse(text: string): string {
	return text.trim();
}

export function convertRenderedAssistantMarkdownToMarkdown(html: string): string {
	return new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" }).turndown(html).trim();
}

function requireTrustedChatGptUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`ChatGPT web URL must use ${CHATGPT_ORIGIN}`);
	}
	if (url.origin !== CHATGPT_ORIGIN || url.username || url.password) {
		throw new Error(`ChatGPT web URL must use ${CHATGPT_ORIGIN} without credentials`);
	}
	return url.toString();
}

function freshChatUrl(url: string): string {
	const freshUrl = new URL(url);
	freshUrl.searchParams.set("temporary-chat", "true");
	return freshUrl.toString();
}

export function getChatGptReadinessMarkerPath(stateDir: string): string {
	return join(stateDir, READINESS_MARKER_FILENAME);
}

async function ensurePrivateStateDir(stateDir: string): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	await chmod(stateDir, 0o700);
}

async function readReadinessMarker(stateDir: string): Promise<ChatGptReadiness | undefined> {
	try {
		const marker = JSON.parse(await readFile(getChatGptReadinessMarkerPath(stateDir), "utf8")) as {
			readonly version?: unknown;
			readonly ready?: unknown;
			readonly accountHash?: unknown;
		};
		return marker.version === MARKER_VERSION
			&& marker.ready === true
			&& typeof marker.accountHash === "string"
			&& /^[a-f0-9]{64}$/.test(marker.accountHash)
			? { accountHash: marker.accountHash }
			: undefined;
	} catch {
		return undefined;
	}
}

async function clearReadinessMarker(stateDir: string): Promise<void> {
	await rm(getChatGptReadinessMarkerPath(stateDir), { force: true });
}

async function writeReadinessMarker(stateDir: string, accountHash: string, signal: AbortSignal): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(accountHash)) {
		throw new Error("ChatGPT automation returned an invalid ChatGPT account identity");
	}
	if (signal.aborted) throw abortError();
	const markerPath = getChatGptReadinessMarkerPath(stateDir);
	const tempPath = `${markerPath}.tmp`;
	const content = `${JSON.stringify({ version: MARKER_VERSION, ready: true, accountHash })}\n`;
	try {
		await writeFile(tempPath, content, { mode: 0o600 });
		await chmod(tempPath, 0o600);
		if (signal.aborted) throw abortError();
		await rename(tempPath, markerPath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

function resolveDependencies(dependencies: ChatGptWebDependencies): {
	readonly config: ChatGptWebConfig;
	readonly automation: ChatGptWebAutomation;
} {
	return {
		config: dependencies.config ?? getConfig(),
		automation: dependencies.automation ?? createPlaywrightChatGptAutomation(),
	};
}

/** Explicit headed authentication flow. Ordinary compaction never waits for interactive login. */
export async function loginToChatGptWeb(
	signal: AbortSignal,
	dependencies: ChatGptWebDependencies = {},
): Promise<void> {
	const { config, automation } = resolveDependencies(dependencies);
	const destination = requireTrustedChatGptUrl(config.url);
	await runSerialized(config.profileDir, signal, async () => {
		await ensurePrivateStateDir(config.stateDir);
		await clearReadinessMarker(config.stateDir);
		const { accountHash } = await automation.login({
			url: destination,
			profileDir: config.profileDir,
			braveExecutablePath: config.braveExecutablePath,
			timeoutMs: config.loginTimeoutMs,
			pollIntervalMs: config.pollIntervalMs,
			headless: false,
			confirm: dependencies.confirmLogin,
		}, signal);
		await writeReadinessMarker(config.stateDir, accountHash, signal);
	});
}

class PlaywrightChatGptTransport implements ChatGptTransport {
	constructor(
		readonly config: ChatGptWebConfig,
		readonly automation: ChatGptWebAutomation,
	) {}

	async complete(request: ChatGptRequest, signal: AbortSignal): Promise<string> {
		const readiness = await readReadinessMarker(this.config.stateDir);
		if (!readiness) {
			throw new Error("ChatGPT web login required; run /chatgpt-web-login before using the web backend");
		}
		try {
			const response = await this.automation.complete({
				url: freshChatUrl(requireTrustedChatGptUrl(this.config.url)),
				prompt: request.prompt,
				expectedAccountHash: readiness.accountHash,
				profileDir: this.config.profileDir,
				braveExecutablePath: this.config.braveExecutablePath,
				timeoutMs: this.config.responseTimeoutMs,
				pollIntervalMs: this.config.pollIntervalMs,
				headless: true,
			}, signal);
			const markdown = convertRenderedAssistantMarkdownToMarkdown(response.markdownHtml);
			if (!markdown) throw new Error("ChatGPT assistant markdown content was empty");
			return markdown;
		} catch (error) {
			if (error instanceof ChatGptWebAuthenticationError) {
				await clearReadinessMarker(this.config.stateDir);
				if (error.reason === "account_changed") {
					throw new Error("ChatGPT web account changed; run /chatgpt-web-login to authorize this account");
				}
				throw new Error("ChatGPT web session expired; run /chatgpt-web-login to authenticate again");
			}
			throw error;
		}
	}
}

/** Creates a headless dedicated-Brave transport gated by explicit authenticated readiness. */
export function createChatGptWebTransport(dependencies: ChatGptWebDependencies = {}): ChatGptTransport {
	const { config, automation } = resolveDependencies(dependencies);
	return serializeChatGptTransportByProfile(
		config.profileDir,
		new PlaywrightChatGptTransport(config, automation),
	);
}
