import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runFileAnalyze } from "../../prompt/file-analyze.js";
import { runSearch } from "../../search/run.js";

const enabled = process.env.PI_GEMINI_ACP === "1";
const command = process.env.PI_GEMINI_ACP_COMMAND ?? "gemini";
const args = (process.env.PI_GEMINI_ACP_ARGS ?? "--acp")
	.split(" ")
	.filter(Boolean);

describe.skipIf(!enabled)("opt-in Gemini ACP smoke", () => {
	it("runs configured Gemini ACP search", async () => {
		const result = await runSearch({
			query: "official Gemini API documentation",
			maxResults: 3,
			config: {
				providers: {
					"gemini-acp": {
						enabled: true,
						command,
						args,
						authenticated: true,
						searchGroundingAvailable: true,
					},
				},
			},
		});
		expect(result.error).toBeUndefined();
		expect(result.results.length).toBeGreaterThan(0);
	}, 120_000);

	it("runs configured Gemini ACP file analysis with resource links", async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), "pi-gemini-smoke-file-"));
		try {
			await writeFile(path.join(cwd, "notes.txt"), "alpha beta gamma", "utf8");
			const result = await runFileAnalyze({
				paths: ["notes.txt"],
				instructions: "Reply with the exact three words in this file.",
				cwd,
				config: {
					providers: {
						"gemini-acp": {
							enabled: true,
							command,
							args,
							authenticated: true,
							searchGroundingAvailable: true,
							permissionPolicy: { filesystemRead: true },
						},
					},
				},
			});
			expect(result.error).toBeUndefined();
			expect(result.text.toLowerCase()).toContain("alpha beta gamma");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 120_000);
});

describe.skipIf(enabled)("opt-in Gemini ACP smoke", () => {
	it("is skipped unless PI_GEMINI_ACP=1", () => {
		expect(process.env.PI_GEMINI_ACP).not.toBe("1");
	});
});
