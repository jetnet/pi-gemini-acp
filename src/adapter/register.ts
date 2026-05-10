/**
 * @fileoverview Wires pi-gemini-acp into pi-scraper's pi:model-adapter protocol.
 */
import { createGeminiSummarizeAdapter } from "./gemini-summarize.js";
import { recordAdapterEmitted } from "./status.js";
import type { RegisteredAdapter } from "./types.js";

const ADAPTER_ID = "gemini-acp";
const PRIORITY = 50;

export interface ModelAdapterRegistrar {
	events?: {
		on(event: string, handler: (payload: unknown) => void): void;
		emit(event: string, payload: unknown): void;
	};
}

export function registerModelAdapter(pi: ModelAdapterRegistrar): void {
	if (process.env.PI_GEMINI_ACP_OFFER_MODEL_ADAPTER === "0") return;
	const events = pi.events;
	if (!events?.on || !events?.emit) return;

	const entry: RegisteredAdapter = {
		id: ADAPTER_ID,
		label: "Gemini (via ACP)",
		capabilities: ["summarize"],
		priority: PRIORITY,
		adapter: createGeminiSummarizeAdapter(),
	};

	events.emit("pi:model-adapter/register", entry);
	recordAdapterEmitted();
	events.on("pi:model-adapter/discover", (_payload: unknown) => {
		events.emit("pi:model-adapter/register", entry);
	});
}
