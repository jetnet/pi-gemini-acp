import type { GeminiAcpSearchRequest } from "./client.ts";

/** Builds the prompt sent to Gemini ACP for grounded web search. */
export function searchPrompt(request: GeminiAcpSearchRequest): string {
	return `Search web: ${request.query}\n\nRespond ONLY with a raw JSON array. Do not include markdown, greetings, explanations, or prose. Start immediately with [{"title":... . Stop after the closing ]. Max ${request.maxResults} results. Format: [{"title":string,"url":string,"snippet":string}]`;
}
