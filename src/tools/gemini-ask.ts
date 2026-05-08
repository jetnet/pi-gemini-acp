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

const ASK_TASK_VALUES = {
	prompt: "prompt",
	extract: "extract",
	summarize: "summarize",
	translate: "translate",
	code_review: "code_review",
} as const;

const FOCUS_VALUES = {
	correctness: "correctness",
	security: "security",
	performance: "performance",
	maintainability: "maintainability",
	tests: "tests",
	api: "api",
	documentation: "documentation",
} as const;

const SEVERITY_VALUES = {
	all: "all",
	important: "important",
	blockers: "blockers",
} as const;

const SUMMARY_STYLE_VALUES = {
	paragraph: "paragraph",
	bullets: "bullets",
	executive: "executive",
} as const;

const askTaskSchema = Type.Enum(ASK_TASK_VALUES);
const focusSchema = Type.Enum(FOCUS_VALUES);
const severitySchema = Type.Enum(SEVERITY_VALUES);
const summaryStyleSchema = Type.Enum(SUMMARY_STYLE_VALUES);

export const geminiAskSchema = Type.Object({
	task: askTaskSchema,
	prompt: Type.Optional(Type.String({ minLength: 1 })),
	content: Type.Optional(Type.String({ minLength: 1 })),
	url: Type.Optional(Type.String()),
	schema: Type.Optional(Type.Any()),
	text: Type.Optional(Type.String({ minLength: 1, maxLength: 80_000 })),
	batch: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String()),
				text: Type.String({ minLength: 1 }),
			}),
			{ minItems: 1, maxItems: 20 },
		),
	),
	targetLanguage: Type.Optional(Type.String({ minLength: 1 })),
	sourceLanguage: Type.Optional(Type.String()),
	tone: Type.Optional(Type.String()),
	glossary: Type.Optional(
		Type.Array(
			Type.Object({
				source: Type.String({ minLength: 1 }),
				target: Type.String({ minLength: 1 }),
				note: Type.Optional(Type.String()),
			}),
			{},
		),
	),
	preserve: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	preservationRules: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	diff: Type.Optional(Type.String()),
	code: Type.Optional(Type.String()),
	context: Type.Optional(Type.String()),
	language: Type.Optional(Type.String()),
	filename: Type.Optional(Type.String()),
	focus: Type.Optional(Type.Array(focusSchema)),
	severityThreshold: Type.Optional(severitySchema),
	maxFindings: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
	sentenceCount: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	bulletCount: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
	audience: Type.Optional(Type.String()),
	style: Type.Optional(summaryStyleSchema),
	maxSourceCharacters: Type.Optional(
		Type.Number({ minimum: 1000, maximum: 50000 }),
	),
	useCache: Type.Optional(Type.Boolean()),
	bypassCache: Type.Optional(Type.Boolean()),
});

type Params = Static<typeof geminiAskSchema>;

export const geminiAskTool = defineGeminiTool({
	name: "gemini_ask",
	label: "Gemini Ask",
	description:
		"Prompt, extract, summarize text or safe public URL, translate, or code-review supplied text/code with Gemini ACP; no file reads, edits, or secrets.",
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
