/**
 * @fileoverview Gemini-backed ModelAdapter exposing summarize capability to
 * pi-scraper via the pi:model-adapter protocol.
 *
 * Delegates to the existing {@link runSummarize} route so the adapter
 * inherits source truncation, API-key fallback, response caching, and
 * cost-estimate plumbing.
 */
import {
	runSummarize,
	type SummarizeDeps,
	type SummarizeOptions,
	type SummarizeRunResult,
	type SummaryStyle,
} from "../prompt/summarize.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./types.js";

export function createGeminiSummarizeAdapter(
	run?: (
		options: SummarizeOptions,
		deps?: SummarizeDeps,
		signal?: AbortSignal,
	) => Promise<SummarizeRunResult>,
): ModelAdapter {
	const executor = run ?? runSummarize;

	return {
		async run<T>(
			request: ModelRequest,
			signal?: AbortSignal,
		): Promise<ModelResponse<T>> {
			if (request.task !== "summarize") {
				throw new Error(
					`gemini-acp adapter does not support task "${request.task}" (only summarize)`,
				);
			}
			const options = mapRequestToSummarizeOptions(request);
			const result = await executor(options, {}, signal);
			if (result.error) {
				throw new Error(result.error.message);
			}
			// raw is provider-specific (SummarizeRunResult); consumers should not
			// depend on field names since they may change with internal refactors.
			return {
				data: { summary: result.summary } as unknown as T,
				text: result.summary,
				raw: result,
			};
		},
	};
}

function mapRequestToSummarizeOptions(request: ModelRequest): SummarizeOptions {
	const opts = request.options ?? {};
	// request.schema is ignored — structured summary extraction is not
	// supported by this adapter. request.options.url is ignored because
	// pi-scraper callers pass already-fetched content in request.input.
	return {
		content: request.input,
		prompt: request.prompt,
		style: validSummaryStyle(opts.style),
		sentenceCount: validFiniteNumber(opts.sentenceCount),
		bulletCount: validFiniteNumber(opts.bulletCount),
		audience: validString(opts.audience),
		title: validString(opts.title),
		maxSourceCharacters: validFiniteNumber(opts.maxSourceCharacters),
	};
}

function validSummaryStyle(value: unknown): SummaryStyle | undefined {
	if (
		typeof value === "string" &&
		(value === "paragraph" || value === "bullets" || value === "executive")
	) {
		return value;
	}
	return undefined;
}

function validFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function validString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0)
		return value.trim();
	return undefined;
}
