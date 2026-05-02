import { type Static, Type } from "@mariozechner/pi-ai";
import { getGeminiAcpStatus } from "../config/status.js";
import { defineGeminiTool } from "./define.js";
import { toolResult } from "./result.js";

export const geminiAcpStatusSchema = Type.Object({});

type Params = Static<typeof geminiAcpStatusSchema>;

export const geminiAcpStatusTool = defineGeminiTool({
	name: "gemini_status",
	label: "Gemini ACP Status",
	description:
		"Report read-only Gemini ACP command/auth/capability status after applying the same default `gemini --acp` settings used by provider-backed search. Local supplied-document workflows do not require Gemini ACP.",
	parameters: geminiAcpStatusSchema,
	async execute(_toolCallId, _params: Params) {
		const status = await getGeminiAcpStatus();
		return toolResult({
			text: statusText(status),
			data: status,
			status: status.ready ? "ok" : "needs_attention",
		});
	},
});

function statusText(
	status: Awaited<ReturnType<typeof getGeminiAcpStatus>>,
): string {
	const headline = status.ready
		? "Gemini ACP is ready for Gemini-backed search/research."
		: `Gemini ACP needs attention: ${status.error?.message ?? status.state}.`;
	const fileAnalysis = status.capabilities.fileAnalysisAvailable;
	return [
		headline,
		`File analysis capability: ${boolLabel(fileAnalysis, "available", "not available")}; gemini_file_analyze returns unsupported until ACP file/document transport is implemented.`,
		`Image input: ${boolLabel(status.capabilities.imageInput.available, "available", "not confirmed")} (${status.capabilities.imageInput.transport}).`,
		...status.remediation.map((item) => `- ${item}`),
	].join("\n");
}

function boolLabel(
	value: boolean | "unknown",
	trueLabel: string,
	falseLabel: string,
): string {
	if (value === "unknown") return "unknown";
	return value ? trueLabel : falseLabel;
}
