import type { GeminiAcpPromptUpdateHandler } from "./client.js";

const SEARCH_EARLY_STOP_ENV = "PI_GEMINI_ACP_SEARCH_EARLY_STOP";

/** Search-stream early-stop state shared by stdio and cached ACP search paths. */
export interface GeminiAcpSearchEarlyStop {
	signal?: AbortSignal;
	onUpdate?: GeminiAcpPromptUpdateHandler;
	parsedPayload(): unknown | undefined;
	stopped(): boolean;
}

/** Returns whether Gemini ACP search stream early-stop is enabled for this process. */
export function geminiAcpSearchEarlyStopEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[SEARCH_EARLY_STOP_ENV] !== "0";
}

/** Builds an update wrapper that aborts once a complete top-level JSON array appears. */
export function createGeminiAcpSearchEarlyStop(
	onUpdate?: GeminiAcpPromptUpdateHandler,
	env: NodeJS.ProcessEnv = process.env,
): GeminiAcpSearchEarlyStop {
	if (!geminiAcpSearchEarlyStopEnabled(env)) {
		return {
			onUpdate,
			parsedPayload: () => undefined,
			stopped: () => false,
		};
	}
	const controller = new AbortController();
	let parsedPayload: unknown;
	let stopped = false;
	return {
		signal: controller.signal,
		onUpdate: async (chunk) => {
			await onUpdate?.(chunk);
			if (stopped) return;
			const detected = completeJsonArrayPayload(chunk.accumulatedText);
			if (!detected.found) return;
			parsedPayload = detected.payload;
			stopped = true;
			controller.abort();
		},
		parsedPayload: () => parsedPayload,
		stopped: () => stopped,
	};
}

/** Finds and parses the first complete JSON array in streamed assistant text. */
export function completeJsonArrayPayload(
	text: string,
): { found: true; payload: unknown } | { found: false } {
	for (
		let start = text.indexOf("[");
		start >= 0;
		start = text.indexOf("[", start + 1)
	) {
		const end = completeJsonArrayEnd(text, start);
		if (end === undefined) return { found: false };
		try {
			return { found: true, payload: JSON.parse(text.slice(start, end + 1)) };
		} catch {
			/* A markdown/link-style bracket can precede the real JSON array. */
		}
	}
	return { found: false };
}

function completeJsonArrayEnd(text: string, start: number): number | undefined {
	let arrayDepth = 0;
	let objectDepth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "[") arrayDepth += 1;
		else if (char === "]") arrayDepth -= 1;
		else if (char === "{") objectDepth += 1;
		else if (char === "}") objectDepth -= 1;
		if (arrayDepth < 0 || objectDepth < 0) return undefined;
		if (arrayDepth === 0 && objectDepth === 0) return index;
	}
	return undefined;
}
