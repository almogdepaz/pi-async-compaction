import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ChatGptWebAuthenticationError,
	createChatGptWebTransport,
	getChatGptReadinessMarkerPath,
	loginToChatGptWeb,
} from "../src/chatgpt-web";
import type { ChatGptWebAutomation, ChatGptWebConfig } from "../src/chatgpt-web";

const ACCOUNT_HASH = "9af211329b2fc82e5efe906062c730082819b23fe8394bc435e0b1bf0458eb54";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStateDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-chatgpt-web-"));
	temporaryDirectories.push(root);
	return join(root, "state");
}

function config(stateDir: string, overrides: Partial<ChatGptWebConfig> = {}): ChatGptWebConfig {
	return {
		stateDir,
		profileDir: join(stateDir, "brave-profile"),
		braveExecutablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		url: "https://chatgpt.com/",
		responseTimeoutMs: 100,
		loginTimeoutMs: 100,
		pollIntervalMs: 1,
		...overrides,
	};
}

interface FakeAutomationOptions {
	readonly interactions?: string[];
	readonly loginError?: Error;
	readonly loginAccountHash?: string;
	readonly completionError?: Error;
	readonly complete?: (input: unknown, signal: AbortSignal) => Promise<{ readonly markdownHtml: string }>;
}

function fakeAutomation(options: FakeAutomationOptions = {}): ChatGptWebAutomation {
	return {
		login: (async (input: unknown) => {
			const request = input as { readonly url: string; readonly profileDir: string; readonly braveExecutablePath: string; readonly headless: boolean };
			options.interactions?.push(`login:${request.url}:${request.profileDir}:${request.braveExecutablePath}:${request.headless}`);
			if (options.loginError) throw options.loginError;
			return { accountHash: options.loginAccountHash ?? ACCOUNT_HASH };
		}) as ChatGptWebAutomation["login"],
		complete: (options.complete ?? (async (input: unknown) => {
			const request = input as { readonly url: string; readonly prompt: string; readonly expectedAccountHash: string; readonly profileDir: string; readonly braveExecutablePath: string; readonly headless: boolean };
			options.interactions?.push(
				`complete:${request.url}:${request.prompt}:${request.expectedAccountHash}:${request.profileDir}:${request.braveExecutablePath}:${request.headless}`,
			);
			if (options.completionError) throw options.completionError;
			return { markdownHtml: "<h2>Goal</h2><p>finished</p>" };
		})) as ChatGptWebAutomation["complete"],
	};
}

async function markReady(stateDir: string, automation: ChatGptWebAutomation): Promise<void> {
	await loginToChatGptWeb(new AbortController().signal, { config: config(stateDir), automation });
}

describe("dedicated Brave ChatGPT automation", () => {
	test("explicit login launches the dedicated profile headed and writes a private account-bound marker", async () => {
		const stateDir = await temporaryStateDir();
		const interactions: string[] = [];
		const expectedConfig = config(stateDir);

		await markReady(stateDir, fakeAutomation({ interactions }));

		const markerPath = getChatGptReadinessMarkerPath(stateDir);
		expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
			version: 3,
			ready: true,
			accountHash: ACCOUNT_HASH,
		});
		expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
		expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
		expect(interactions).toEqual([
			`login:https://chatgpt.com/:${expectedConfig.profileDir}:${expectedConfig.braveExecutablePath}:false`,
		]);
	});

	test("rejects a malformed automation account hash without creating readiness", async () => {
		const stateDir = await temporaryStateDir();

		await expect(loginToChatGptWeb(new AbortController().signal, {
			config: config(stateDir),
			automation: fakeAutomation({ loginAccountHash: "not-a-sha256-hash" }),
		})).rejects.toThrow("invalid ChatGPT account identity");
		await expect(stat(getChatGptReadinessMarkerPath(stateDir))).rejects.toThrow();
	});

	test("legacy normal-profile readiness fails before invoking Brave", async () => {
		const stateDir = await temporaryStateDir();
		await mkdir(stateDir, { recursive: true });
		await writeFile(getChatGptReadinessMarkerPath(stateDir), JSON.stringify({ version: 2, ready: true, accountHash: ACCOUNT_HASH }));
		const interactions: string[] = [];
		const transport = createChatGptWebTransport({
			config: config(stateDir),
			automation: fakeAutomation({ interactions }),
		});

		await expect(transport.complete(
			{ id: "missing", kind: "history", prompt: "must not send" },
			new AbortController().signal,
		)).rejects.toThrow("run /chatgpt-web-login");
		expect(interactions).toEqual([]);
	});

	test("ordinary completion launches that profile headlessly only after readiness", async () => {
		const stateDir = await temporaryStateDir();
		await markReady(stateDir, fakeAutomation());
		const interactions: string[] = [];
		const expectedConfig = config(stateDir);
		const transport = createChatGptWebTransport({
			config: expectedConfig,
			automation: fakeAutomation({ interactions }),
		});

		expect(await transport.complete(
			{ id: "complete", kind: "history", prompt: "summarize this" },
			new AbortController().signal,
		)).toBe("## Goal\n\nfinished");
		expect(interactions).toEqual([
			`complete:https://chatgpt.com/?temporary-chat=true:summarize this:${ACCOUNT_HASH}:${expectedConfig.profileDir}:${expectedConfig.braveExecutablePath}:true`,
		]);
	});

	test("clears readiness when the headless operation reports an account change or expired session", async () => {
		for (const error of [
			new ChatGptWebAuthenticationError("account_changed"),
			new ChatGptWebAuthenticationError("session_expired"),
		]) {
			const stateDir = await temporaryStateDir();
			await markReady(stateDir, fakeAutomation());
			const transport = createChatGptWebTransport({
				config: config(stateDir),
				automation: fakeAutomation({ completionError: error }),
			});

			await expect(transport.complete(
				{ id: error.reason, kind: "history", prompt: "must not send" },
				new AbortController().signal,
			)).rejects.toThrow(error.reason === "account_changed" ? "account changed" : "run /chatgpt-web-login");
			await expect(stat(getChatGptReadinessMarkerPath(stateDir))).rejects.toThrow();
		}
	});

	test("rejects untrusted configured URLs before invoking Brave", async () => {
		for (const url of [
			"http://chatgpt.com/",
			"https://user:secret@chatgpt.com/",
			"https://chatgpt.com.evil.example/",
			"not a url",
		]) {
			const stateDir = await temporaryStateDir();
			const interactions: string[] = [];
			await expect(loginToChatGptWeb(new AbortController().signal, {
				config: config(stateDir, { url }),
				automation: fakeAutomation({ interactions }),
			})).rejects.toThrow("https://chatgpt.com");
			expect(interactions).toEqual([]);
		}
	});

	test("propagates abort while the one owned headless browser operation is active", async () => {
		const stateDir = await temporaryStateDir();
		await markReady(stateDir, fakeAutomation());
		const controller = new AbortController();
		let started = false;
		const transport = createChatGptWebTransport({
			config: config(stateDir),
			automation: fakeAutomation({
				complete: async (_input, signal) => {
					started = true;
					return new Promise((resolve, reject) => {
						signal.addEventListener("abort", () => {
							const error = new Error("ChatGPT request aborted");
							error.name = "AbortError";
							reject(error);
						}, { once: true });
					});
				},
			}),
		});
		const completion = transport.complete(
			{ id: "abort", kind: "history", prompt: "summarize" },
			controller.signal,
		);
		while (!started) await Bun.sleep(1);
		controller.abort();

		await expect(completion).rejects.toMatchObject({ name: "AbortError" });
	});
});
