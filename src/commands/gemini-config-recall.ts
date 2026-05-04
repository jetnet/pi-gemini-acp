import {
	loadConfig,
	recallEnabledFromConfig,
	saveRecallEnabled,
} from "../config/settings.js";
import { defaultEmbedder } from "../recall/embedder.js";
import type { StorageOptions } from "../storage/paths.js";
import { toolResult } from "../tools/result.js";
import type { PiToolShell, ResultEnvelope } from "../types.js";

export interface GeminiConfigRecallParams {
	recallAction?: "enable" | "disable" | "status";
}

export interface GeminiConfigRecallResult {
	action: "enable" | "disable" | "status";
	recallEnabled: boolean;
	envDisabled: boolean;
	embedderAvailable: boolean;
	embedderReason?: string;
}

/** Toggles background semantic recall embedding writes. */
export async function runGeminiConfigRecall(
	params: GeminiConfigRecallParams = {},
	options: StorageOptions = {},
): Promise<PiToolShell<ResultEnvelope<GeminiConfigRecallResult>>> {
	const action = params.recallAction ?? "status";
	if (action === "enable" || action === "disable") {
		await saveRecallEnabled(action === "enable", options);
	}
	const config = await loadConfig(options);
	const embedder = await defaultEmbedder().status(options);
	const result = {
		action,
		recallEnabled: recallEnabledFromConfig(config),
		envDisabled: process.env.PI_GEMINI_ACP_RECALL === "0",
		embedderAvailable: embedder.available,
		embedderReason: embedder.reason,
	} satisfies GeminiConfigRecallResult;
	return toolResult({ text: recallText(result), data: result });
}

function recallText(result: GeminiConfigRecallResult): string {
	return [
		"Gemini semantic recall embeddings:",
		`- enabled: ${result.recallEnabled ? "yes" : "no"}`,
		`- env disabled: ${result.envDisabled ? "yes" : "no"}`,
		`- embedder: ${result.embedderAvailable ? "available" : "unavailable"}`,
		result.embedderReason ? `- reason: ${result.embedderReason}` : undefined,
		result.envDisabled
			? "- note: PI_GEMINI_ACP_RECALL=0 overrides persisted settings."
			: undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}
