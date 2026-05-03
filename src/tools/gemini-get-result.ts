import { type Static, Type } from "@mariozechner/pi-ai";
import { getStoredResult } from "../storage/results.js";
import type { PiToolShell, ResultEnvelope, StructuredError } from "../types.js";
import { defineGeminiTool, type ToolRenderResultOptions } from "./define.js";
import {
	boxedToolText,
	dimToolText,
	expandedToolOutputHint,
	formatCollapsedOrExpanded,
	renderGeminiToolCallTitle,
	truncateToolText,
} from "./gemini-rendering.js";
import { errorResult, toolResult } from "./result.js";

export const geminiAcpGetResultSchema = Type.Object({
	responseId: Type.String({ description: "Stored result responseId." }),
});

type Params = Static<typeof geminiAcpGetResultSchema>;

export const geminiAcpGetResultTool = defineGeminiTool({
	name: "gemini_get_result",
	label: "Gemini ACP Get Result",
	description:
		"Retrieve full stored Gemini ACP search/research output by responseId.",
	parameters: geminiAcpGetResultSchema,
	async execute(_toolCallId, params: Params) {
		try {
			const stored = await getStoredResult(params.responseId);
			return toolResult({
				text: `Retrieved result ${params.responseId}.`,
				data: stored.value,
				responseId: params.responseId,
				fullOutputPath: stored.path,
			});
		} catch {
			return errorResult({
				code: "RESULT_NOT_FOUND",
				phase: "storage",
				message: `Result not found: ${params.responseId}`,
				retryable: false,
			});
		}
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_get_result",
			stateKey: "geminiGetResultTitle",
		});
	},
	renderResult(result, options, theme) {
		return boxedToolText(
			dimToolText(formatGetResultToolDisplay(result, options), theme),
		);
	},
});

function formatGetResultToolDisplay(
	result: PiToolShell,
	options: ToolRenderResultOptions,
): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	if (details.error) return formatError(details.error, options);
	return formatCollapsedOrExpanded(result, options, {
		collapsed: formatGetResultCollapsed,
		expanded: formatGetResultExpanded,
	});
}

function formatGetResultCollapsed(result: PiToolShell): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	const responseId = details.responseId ?? "unknown";
	return [
		`Retrieved stored Gemini result: ${responseId}`,
		storedValueSummary(details.data),
		expandedToolOutputHint("stored result JSON and path"),
	]
		.filter(Boolean)
		.join("\n");
}

function formatGetResultExpanded(result: PiToolShell): string {
	const details = result.details as Partial<ResultEnvelope<unknown>>;
	return [
		result.content[0]?.text,
		details.responseId ? `responseId: ${details.responseId}` : undefined,
		details.fullOutputPath
			? `fullOutputPath: ${details.fullOutputPath}`
			: undefined,
		"Stored result preview:",
		truncateToolText(JSON.stringify(details.data, null, 2), 4_000),
	]
		.filter(Boolean)
		.join("\n");
}

function formatError(
	error: StructuredError,
	options: ToolRenderResultOptions,
): string {
	return formatCollapsedOrExpanded(error, options, {
		collapsed: (value) => value.message,
		expanded: (value) =>
			[
				value.message,
				`code: ${value.code}`,
				value.phase ? `phase: ${value.phase}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
	});
}

function storedValueSummary(value: unknown): string | undefined {
	if (isRecord(value)) {
		const keys = Object.keys(value).slice(0, 6);
		return keys.length ? `top-level keys: ${keys.join(", ")}` : undefined;
	}
	if (typeof value === "string") return truncateToolText(value, 180);
	return value === undefined ? undefined : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
