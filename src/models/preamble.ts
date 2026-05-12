/** @file Pi-aware preamble builder for Gemini ACP prompts. */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Minimal shape needed from Pi to enumerate active skills. */
export interface PiSkillsSource {
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string }>;
}

/** Options for building the Pi-aware prompt preamble. */
export interface PreambleOptions {
	modelId: string;
	cwd: string;
	appendSystemPrompt: boolean;
	appendAgents: boolean;
	appendSkills: boolean;
	pi: PiSkillsSource;
	upstreamSystemPrompt?: string;
}

const AGENTS_MAX_BYTES = 32_768;
const AGENTS_FILE = "AGENTS.md";

/** Builds a Pi-aware preamble string for injection ahead of the user history. */
export async function buildPiPreamble(opts: PreambleOptions): Promise<string> {
	const { appendSystemPrompt, appendAgents, appendSkills } = opts;
	if (!appendSystemPrompt && !appendAgents && !appendSkills) return "";

	const lines: string[] = [];

	if (appendSystemPrompt) {
		lines.push(
			"You are running inside Pi, an AI coding agent CLI.",
			`Model: ${opts.modelId}`,
			`Working directory: ${opts.cwd}`,
			"",
		);
	}

	if (opts.upstreamSystemPrompt) {
		lines.push(opts.upstreamSystemPrompt, "");
	}

	if (appendAgents) {
		const agentsContent = await readAgentsMd(opts.cwd);
		if (agentsContent) {
			lines.push("## Project context (AGENTS.md)", "", agentsContent, "");
		}
	}

	if (appendSkills) {
		const skillsList = formatSkillsList(opts.pi);
		if (skillsList) {
			lines.push("## Available skills", "", skillsList, "");
		}
	}

	return lines.join("\n").trim();
}

/** Reads AGENTS.md from cwd, capped at ~32 KB. */
async function readAgentsMd(cwd: string): Promise<string | undefined> {
	try {
		const content = await readFile(path.resolve(cwd, AGENTS_FILE), "utf8");
		const trimmed = content.trim();
		if (!trimmed) return undefined;
		if (Buffer.byteLength(trimmed, "utf8") > AGENTS_MAX_BYTES) {
			return trimmed.slice(0, AGENTS_MAX_BYTES) + "\n\n[truncated]";
		}
		return trimmed;
	} catch {
		return undefined;
	}
}

/** Formats the active skills list from Pi's registrar. */
function formatSkillsList(pi: PiSkillsSource): string | undefined {
	const active = pi.getActiveTools?.();
	if (active && active.length > 0) {
		return active.map((name) => `- ${name}`).join("\n");
	}
	const all = pi.getAllTools?.();
	if (all && all.length > 0) {
		return all.map((t) => `- ${t.name}`).join("\n");
	}
	return undefined;
}
