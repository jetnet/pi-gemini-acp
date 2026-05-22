/** @file Tests for Gemini ACP search prewarm scheduling and status. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
	GeminiAcpPromptRequest,
} from "../../acp/client.ts";
import { saveGeminiAcpSettings } from "../../config/settings.ts";
import type { SearchResultItem } from "../../types.ts";
import {
	__resetGeminiSearchPrewarmStatus,
	getGeminiSearchPrewarmStatus,
	prewarmGeminiSearchClient,
	scheduleGeminiSearchPrewarm,
} from "../prewarm.ts";
import { __resetGeminiSearchPreflightCache, runSearch } from "../run.ts";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-prewarm-"));
});

afterEach(async () => {
	__resetGeminiSearchPreflightCache();
	__resetGeminiSearchPrewarmStatus();
	await rm(rootDir, { recursive: true, force: true });
});

describe("Gemini search prewarm", () => {
	it("short-circuits when PI_GEMINI_ACP_NO_PREWARM is enabled", async () => {
		let loaded = false;
		let warmed = false;

		const result = await prewarmGeminiSearchClient(
			{ env: { PI_GEMINI_ACP_NO_PREWARM: "1" } },
			{
				loadConfig: async () => {
					loaded = true;
					return {};
				},
				warmSearchClient: async () => {
					warmed = true;
				},
			},
		);

		expect(result).toMatchObject({
			attempted: false,
			warmed: false,
			skippedReason: "disabled",
		});
		expect(loaded).toBe(false);
		expect(warmed).toBe(false);
		expect(getGeminiSearchPrewarmStatus()).toMatchObject({
			state: "disabled",
			attempted: false,
			warmed: false,
		});
	});

	it("populates the search preflight cache before the first user search", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				args: ["--acp"],
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;
		let warmedSettings: GeminiAcpCommandSettings | undefined;
		const deps = {
			commandExists: async () => {
				commandChecks += 1;
				return true;
			},
		};

		const prewarm = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				...deps,
				warmSearchClient: async (settings) => {
					warmedSettings = settings;
				},
			},
		);
		const result = await runSearch(
			{ query: "after-prewarm", rootDir },
			{ ...deps, geminiAcpClient: new FakeGeminiClient() },
		);

		expect(prewarm).toMatchObject({ attempted: true, warmed: true });
		expect(getGeminiSearchPrewarmStatus()).toMatchObject({
			state: "warmed",
			attempted: true,
			warmed: true,
		});
		expect(warmedSettings?.command).toBe("gemini");
		expect(result.error).toBeUndefined();
		expect(commandChecks).toBe(1);
	});

	it("uses the primary account env for warm cache when accounts are configured", async () => {
		let warmedSettings: GeminiAcpCommandSettings | undefined;

		const prewarm = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				loadConfig: async () => ({
					providers: {
						"gemini-acp": {
							enabled: true,
							command: "gemini",
							args: ["--acp"],
							authenticated: true,
							searchGroundingAvailable: true,
						},
						accounts: {
							entries: [
								{
									name: "primary",
									env: { GEMINI_CLI_HOME: "/tmp/gemini-primary" },
								},
								{
									name: "secondary",
									env: { GEMINI_CLI_HOME: "/tmp/gemini-secondary" },
								},
							],
						},
					},
				}),
				commandExists: async () => true,
				warmSearchClient: async (settings) => {
					warmedSettings = settings;
				},
			},
		);

		expect(prewarm).toMatchObject({ attempted: true, warmed: true });
		expect(warmedSettings?.env).toEqual({ GEMINI_CLI_HOME: "/tmp/gemini-primary" });
	});

	it("does not cache transient preflight failures", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);
		let commandChecks = 0;

		const prewarm = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				commandExists: async () => {
					commandChecks += 1;
					return false;
				},
			},
		);
		const result = await runSearch(
			{ query: "after-failed-prewarm", rootDir },
			{
				commandExists: async () => {
					commandChecks += 1;
					return true;
				},
				geminiAcpClient: new FakeGeminiClient(),
			},
		);

		expect(prewarm).toMatchObject({
			attempted: true,
			warmed: false,
			skippedReason: "preflight",
		});
		expect(result.error).toBeUndefined();
		expect(commandChecks).toBe(2);
	});

	it("survives warm client startup failures", async () => {
		await saveGeminiAcpSettings(
			{
				enabled: true,
				command: "gemini",
				authenticated: true,
				searchGroundingAvailable: true,
			},
			{ rootDir },
		);

		const result = await prewarmGeminiSearchClient(
			{ rootDir },
			{
				commandExists: async () => true,
				warmSearchClient: async () => {
					throw new Error("planned warm failure");
				},
			},
		);

		expect(result).toMatchObject({
			attempted: true,
			warmed: false,
			skippedReason: "failed",
		});
		expect(result.cause).toBeInstanceOf(Error);
	});

	it("schedules prewarm after activation without running inline", () => {
		let scheduled: (() => void) | undefined;
		let unrefCalls = 0;

		scheduleGeminiSearchPrewarm(
			{ env: {} },
			{
				schedule: (callback) => {
					scheduled = callback;
					return {
						unref: () => {
							unrefCalls += 1;
						},
					};
				},
			},
		);

		expect(typeof scheduled).toBe("function");
		expect(unrefCalls).toBe(1);
	});

	it("returned cancel clears the pending schedule handle and is idempotent", () => {
		let cancelCalls = 0;
		let scheduled: (() => void) | undefined;

		const cancel = scheduleGeminiSearchPrewarm(
			{ env: {} },
			{
				schedule: (callback) => {
					scheduled = callback;
					return {
						cancel: () => {
							cancelCalls += 1;
						},
					};
				},
			},
		);

		expect(typeof scheduled).toBe("function");
		expect(typeof cancel).toBe("function");

		cancel();
		cancel();

		expect(cancelCalls).toBe(1);
	});

	it("returned cancel is a no-op after the callback has fired", () => {
		let cancelCalls = 0;
		let scheduled: (() => void) | undefined;

		const cancel = scheduleGeminiSearchPrewarm(
			// Disable the actual prewarm work the callback would kick off; we only care
			// that cancel() does not call handle.cancel() after the timer fires.
			{ env: { PI_GEMINI_ACP_NO_PREWARM: "1" } },
			{
				schedule: (callback) => {
					scheduled = callback;
					return {
						cancel: () => {
							cancelCalls += 1;
						},
					};
				},
			},
		);

		scheduled?.();
		cancel();

		expect(cancelCalls).toBe(0);
	});

	it("returns a safe no-op cancel when prewarm is disabled", () => {
		let scheduleCalls = 0;

		const cancel = scheduleGeminiSearchPrewarm(
			{ env: { PI_GEMINI_ACP_NO_PREWARM: "1" } },
			{
				schedule: () => {
					scheduleCalls += 1;
					return {};
				},
			},
		);

		expect(scheduleCalls).toBe(0);
		expect(() => {
			cancel();
			cancel();
		}).not.toThrow();
	});

	it("short-circuits prewarmGeminiSearchClient when the abort signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let loaded = false;
		let warmed = false;

		const result = await prewarmGeminiSearchClient(
			{ env: {}, signal: controller.signal },
			{
				loadConfig: async () => {
					loaded = true;
					return {};
				},
				warmSearchClient: async () => {
					warmed = true;
				},
			},
		);

		expect(result).toMatchObject({
			attempted: false,
			warmed: false,
			skippedReason: "aborted",
		});
		expect(loaded).toBe(false);
		expect(warmed).toBe(false);
	});
});

class FakeGeminiClient implements GeminiAcpClient {
	async prompt(request: GeminiAcpPromptRequest): Promise<string> {
		return "prompt" in request ? request.prompt : "";
	}

	async search(): Promise<SearchResultItem[]> {
		return [
			{
				title: "Gemini",
				url: "https://example.com/g",
				normalizedUrl: "https://example.com/g",
				snippet: "g",
				ranking: 1,
				source: {
					provider: "gemini-acp",
					kind: "gemini-acp",
					requiresCloud: false,
					requiresApiKey: false,
					requiresLocalAuth: true,
				},
			},
		];
	}
}
