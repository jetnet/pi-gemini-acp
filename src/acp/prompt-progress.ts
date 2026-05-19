/** @file Shared Gemini backend-wait and first-token progress helpers. */
import type { GeminiAcpPromptUpdateHandler } from "./client.ts";

export type GeminiBackendProgressState = "waiting" | "generating";
export type GeminiBackendProgressContext = "prompt" | "search";
export type GeminiBackendProgressEmitter = (message: string) => void | Promise<void>;

const WAITING_PROGRESS_TEXT: Record<GeminiBackendProgressContext, string> = {
	prompt: "● Querying Gemini model; awaiting first token (backend/network latency)...",
	search:
		"● Querying Gemini search; awaiting grounded results (backend + web grounding + first-token latency)...",
};
const GENERATING_PROGRESS_TEXT = "● First token received; LLM generating tokens...";

/** Formats the shared Gemini backend progress message, optionally under a header. */
export function geminiBackendProgressText(
	state: GeminiBackendProgressState,
	header?: string,
	context: GeminiBackendProgressContext = "prompt",
): string {
	const text = state === "waiting" ? WAITING_PROGRESS_TEXT[context] : GENERATING_PROGRESS_TEXT;
	return header ? `${header}\n\n${text}` : text;
}

/** Emits a shared Gemini backend progress message. */
export async function emitGeminiBackendProgress(
	emit: GeminiBackendProgressEmitter | undefined,
	state: GeminiBackendProgressState,
	header?: string,
	context?: GeminiBackendProgressContext,
): Promise<void> {
	await emit?.(geminiBackendProgressText(state, header, context));
}

/** Wraps a prompt chunk handler and emits first-token progress exactly once. */
export function withGeminiBackendProgress(
	onUpdate?: GeminiAcpPromptUpdateHandler,
	emit?: GeminiBackendProgressEmitter,
	header?: string,
	context?: GeminiBackendProgressContext,
): GeminiAcpPromptUpdateHandler {
	let receivedFirstToken = false;
	return async (chunk) => {
		if (!receivedFirstToken) {
			receivedFirstToken = true;
			await emitGeminiBackendProgress(emit, "generating", header, context);
		}
		await onUpdate?.(chunk);
	};
}
