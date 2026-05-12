/** @file Tests for GeminiApiKeyClient defensive checks and fallback behavior. */
import { describe, expect, it } from "vitest";

import { GeminiApiKeyClient } from "../client.ts";

describe("GeminiApiKeyClient", () => {
	it("throws on prompt request containing resource_link parts", async () => {
		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key-fake" } } },
			fetch: () => {
				throw new Error("fetch should not be called");
			},
		});

		await expect(
			client.prompt({
				parts: [
					{ type: "text", text: "Analyze:" },
					{ type: "resource_link", uri: "file:///etc/passwd", name: "passwd" },
				],
			}),
		).rejects.toThrow(/GEMINI_API_KEY_UNSUPPORTED_TRANSPORT/u);
	});

	it("accepts plain text prompt requests", async () => {
		const client = new GeminiApiKeyClient({
			config: { providers: { "gemini-acp": { apiKey: "test-key-fake" } } },
			fetch: async () =>
				({
					ok: true,
					json: async () => ({
						candidates: [{ content: { parts: [{ text: "ok" }] } }],
					}),
				}) as Response,
		});

		const result = await client.prompt({ prompt: "Hello" });
		expect(result).toBe("ok");
	});
});
