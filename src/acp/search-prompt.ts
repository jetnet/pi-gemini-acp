import type { GeminiAcpSearchRequest } from "./client.js";

/** Builds the prompt currently required because ACP has no stable search RPC. */
export function searchPrompt(request: GeminiAcpSearchRequest): string {
	return `Grounded web search: ${request.query}\nReturn JSON only, no Markdown/prose, max ${request.maxResults}: [{"title":string,"url":string,"snippet":string}]`;
}
