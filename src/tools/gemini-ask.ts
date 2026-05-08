/**
 * @fileoverview Aggregate Gemini ACP text task tool for prompt, extract, summarize, translate, and code review workflows.
 */
import { type Static, Type } from "@mariozechner/pi-ai";
import type { PiToolShell, ResultEnvelope } from "../types.js";
import {
	defineGeminiTool,
	type ToolRenderContext,
	type ToolRenderResultOptions,
} from "./define.js";
import { geminiAcpCodeReviewTool } from "./gemini-code-review.js";
import { geminiAcpExtractTool } from "./gemini-extract.js";
import { geminiAcpPromptTool } from "./gemini-prompt.js";
import { renderGeminiToolCallTitle } from "./gemini-rendering.js";
import { geminiAcpSummarizeTool } from "./gemini-summarize.js";
import { geminiAcpTranslateTool } from "./gemini-translate.js";

const askTaskSchema = Type.Union([
	Type.Literal("prompt"),
	Type.Literal("extract"),
	Type.Literal("summarize"),
	Type.Literal("translate"),
	Type.Literal("code_review"),
]);

const focusSchema = Type.Union([
	Type.Literal("correctness"),
	Type.Literal("security"),
	Type.Literal("performance"),
	Type.Literal("maintainability"),
	Type.Literal("tests"),
	Type.Literal("api"),
	Type.Literal("documentation"),
]);

const severitySchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("important"),
	Type.Literal("blockers"),
]);

export const geminiAskSchema = Type.Object({
	task: askTaskSchema,
	prompt: Type.Optional(
		Type.String({ minLength: 1, description: "Prompt/instructions." }),
	),
	content: Type.Optional(
		Type.String({ minLength: 1, description: "Source text/content." }),
	),
	url: Type.Optional(
		Type.String({ description: "Safe public URL for summarize." }),
	),
	schema: Type.Optional(Type.Any({ description: "JSON schema for extract." })),
	text: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 80_000,
			description: "Text to translate.",
		}),
	),
	batch: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String({ description: "Stable item id." })),
				text: Type.String({ minLength: 1, description: "Batch item text." }),
			}),
			{ minItems: 1, maxItems: 20, description: "Batch translation items." },
		),
	),
	targetLanguage: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Target language for translate.",
		}),
	),
	sourceLanguage: Type.Optional(
		Type.String({ description: "Source language; omit to auto-detect." }),
	),
	tone: Type.Optional(Type.String({ description: "Target tone/register." })),
	glossary: Type.Optional(
		Type.Array(
			Type.Object({
				source: Type.String({ minLength: 1 }),
				target: Type.String({ minLength: 1 }),
				note: Type.Optional(Type.String()),
			}),
			{ description: "Required source→target terms." },
		),
	),
	preserve: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Terms/placeholders to keep unchanged.",
		}),
	),
	preservationRules: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Extra preservation rules.",
		}),
	),
	diff: Type.Optional(Type.String({ description: "Unified diff/patch text." })),
	code: Type.Optional(Type.String({ description: "Code/excerpt text." })),
	context: Type.Optional(
		Type.String({ description: "Extra review context; avoid secrets." }),
	),
	language: Type.Optional(Type.String({ description: "Language hint." })),
	filename: Type.Optional(
		Type.String({ description: "Display filename/label." }),
	),
	focus: Type.Optional(
		Type.Array(focusSchema, { description: "Review focus." }),
	),
	severityThreshold: Type.Optional(severitySchema),
	maxFindings: Type.Optional(
		Type.Number({ minimum: 1, maximum: 50, description: "Max findings." }),
	),
	sentenceCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Approx sentence count.",
		}),
	),
	bulletCount: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 20,
			description: "Exact bullet count.",
		}),
	),
	audience: Type.Optional(Type.String({ description: "Summary audience." })),
	style: Type.Optional(
		Type.Union([
			Type.Literal("paragraph"),
			Type.Literal("bullets"),
			Type.Literal("executive"),
		]),
	),
	maxSourceCharacters: Type.Optional(
		Type.Number({
			minimum: 1000,
			maximum: 50000,
			description: "Max source chars.",
		}),
	),
	useCache: Type.Optional(Type.Boolean({ description: "Use response cache." })),
	bypassCache: Type.Optional(
		Type.Boolean({ description: "Skip response cache." }),
	),
});

type Params = Static<typeof geminiAskSchema>;

export const geminiAskTool = defineGeminiTool({
	name: "gemini_ask",
	label: "Gemini Ask",
	description:
		"Prompt, extract, summarize, translate, or code-review supplied text with Gemini ACP.",
	parameters: geminiAskSchema,
	execute(toolCallId, params: Params, signal, onUpdate) {
		switch (params.task) {
			case "prompt":
				return geminiAcpPromptTool.execute(
					toolCallId,
					{
						prompt: params.prompt ?? params.content ?? "",
						useCache: params.useCache,
						bypassCache: params.bypassCache,
					},
					signal,
					onUpdate,
				);
			case "extract":
				return geminiAcpExtractTool.execute(
					toolCallId,
					{
						content: params.content ?? "",
						prompt: params.prompt ?? "Extract structured data.",
						schema: params.schema,
						bypassCache: params.bypassCache,
					},
					signal,
					onUpdate,
				);
			case "summarize":
				return geminiAcpSummarizeTool.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
				);
			case "translate":
				return geminiAcpTranslateTool.execute(
					toolCallId,
					{ ...params, targetLanguage: params.targetLanguage ?? "" },
					signal,
					onUpdate,
				);
			case "code_review":
				return geminiAcpCodeReviewTool.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
				);
		}
	},
	renderCall(_args, theme, context) {
		return renderGeminiToolCallTitle(context, theme, {
			toolName: "gemini_ask",
			stateKey: "geminiAskTitle",
		});
	},
	renderResult(result, options, theme, context) {
		return askRenderTarget(result).renderResult!(
			result,
			options,
			theme,
			context,
		);
	},
});

function askRenderTarget(result: PiToolShell) {
	const data = (result.details as Partial<ResultEnvelope<unknown>>).data;
	const record = data && typeof data === "object" ? data : {};
	if ("findings" in record || "sections" in record)
		return geminiAcpCodeReviewTool;
	if (
		"targetLanguage" in record ||
		"translations" in record ||
		"items" in record
	)
		return geminiAcpTranslateTool;
	if ("source" in record && "summary" in record) return geminiAcpSummarizeTool;
	if ("extracted" in record) return geminiAcpExtractTool;
	return geminiAcpPromptTool;
}
