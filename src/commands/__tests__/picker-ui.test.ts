import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config/settings.js";
import type { ResultEnvelope } from "../../types.js";
import type { PiCommandContext } from "../define.js";
import { runGeminiConfigCommand } from "../gemini-config.js";
import { runGeminiModelCommand } from "../gemini-model.js";

let rootDir: string;

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "pi-gemini-acp-picker-ui-"));
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

function makeInteractiveCtx(options: {
	select?: Array<string | undefined>;
	input?: string | undefined;
	confirm?: boolean;
}): {
	ctx: PiCommandContext;
	select: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
} {
	const selections = [...(options.select ?? [])];
	const select = vi.fn(async () => selections.shift());
	const confirm = vi.fn(async () => options.confirm ?? false);
	const input = vi.fn(async () => options.input);
	const notify = vi.fn();
	return {
		ctx: {
			hasUI: true,
			ui: { select, confirm, input, notify },
		},
		select,
		confirm,
		input,
		notify,
	};
}

describe("Gemini ACP command pickers", () => {
	it("uses Pi select for /gemini-config with no args", async () => {
		const { ctx, select } = makeInteractiveCtx({ select: [undefined] });

		const result = await runGeminiConfigCommand({}, ctx, { rootDir });

		expect(select).toHaveBeenCalledWith(
			"Gemini config",
			["Status", "Persist", "Permissions"],
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toBe("Cancelled.");
	});

	it("uses Pi input after selecting Persist", async () => {
		const { ctx, input } = makeInteractiveCtx({
			select: ["Persist"],
			input: "gemini --acp",
		});

		const result = await runGeminiConfigCommand({}, ctx, {
			rootDir,
			commandExists: async (command) => command === "gemini",
		});

		expect(input).toHaveBeenCalledWith("Gemini ACP command", "gemini --acp", {
			signal: undefined,
		});
		expect(result.content[0]?.text).toContain(
			"Saved Gemini ACP command: gemini --acp",
		);
		expect((result.details as ResultEnvelope).error).toBeUndefined();
	});

	it("uses Pi select for /gemini-model with no args", async () => {
		const { ctx, select } = makeInteractiveCtx({
			select: ["Gemini 3.1 Pro Preview — gemini-3.1-pro-preview"],
		});

		const result = await runGeminiModelCommand({}, ctx, {
			rootDir,
			commandExists: async () => true,
			readCommandHelp: async () => "--model Model [string]",
		});

		expect(select).toHaveBeenCalledWith(
			"Choose a Gemini model",
			expect.arrayContaining([
				"Gemini 3.1 Pro Preview — gemini-3.1-pro-preview",
			]),
			{ signal: undefined },
		);
		expect(result.content[0]?.text).toBe(
			"Selected model: gemini-3.1-pro-preview.",
		);
	});

	it("uses Pi confirm before enabling write permissions", async () => {
		const { ctx, confirm } = makeInteractiveCtx({
			select: ["[ ] Filesystem write (⚠️ requires confirmation)", "Done"],
			confirm: true,
		});

		await runGeminiConfigCommand({ action: "permissions" }, ctx, { rootDir });

		expect(confirm).toHaveBeenCalledWith(
			"Enable Filesystem write?",
			expect.stringContaining(
				"Allow Gemini ACP to write text files to your workspace.",
			),
			{ signal: undefined },
		);
		expect(
			(await loadConfig({ rootDir })).providers?.["gemini-acp"]
				?.permissionPolicy,
		).toMatchObject({ filesystemWrite: true });
	});

	it("returns a cancelled result when the config picker is dismissed", async () => {
		const { ctx } = makeInteractiveCtx({ select: [] });

		const result = await runGeminiConfigCommand({}, ctx, { rootDir });

		expect(result.content[0]?.text).toBe("Cancelled.");
		expect((result.details as ResultEnvelope).data).toMatchObject({
			cancelled: true,
		});
	});
});
