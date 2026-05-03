import type {
	GeminiAcpClient,
	GeminiAcpCommandSettings,
} from "../acp/client.js";
import { getCachedGeminiAcpClient } from "../acp/client-cache.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import {
	configFromEnv,
	loadConfig,
	withDefaultGeminiAcpConfig,
} from "../config/settings.js";
import {
	type GeminiAcpAuthProbe,
	preflightGeminiAcpProvider,
	type StatusCommandChecker,
} from "../config/status.js";
import { storeResult } from "../storage/results.js";
import type {
	GeminiAcpConfig,
	GeminiAcpProviderSettings,
	StructuredError,
} from "../types.js";

export const PROMPT_RESPONSE_INLINE_LIMIT = 4_000;

export type PromptRequestArgument = string | number | boolean | undefined;

/** Sanitized request metadata shown in progress without exposing full prompt content. */
export interface PromptRequestSummary {
	toolName: `gemini_${string}`;
	action: string;
	subject?: string;
	arguments?: Record<string, PromptRequestArgument>;
}

/** Inputs for a generic Gemini ACP prompt run. */
export interface PromptOptions {
	prompt: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
	cwd?: string;
	inlineLimit?: number;
	useDefaultConfig?: boolean;
	requestSummary?: PromptRequestSummary;
}

/** Injectable dependencies for prompt tests and future shared status wiring. */
export interface PromptDeps {
	geminiAcpClient?: GeminiAcpClient;
	geminiAcpClientFactory?: (
		settings: GeminiAcpCommandSettings,
	) => GeminiAcpClient;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
}

/** Streaming or phase update emitted by the prompt workflow. */
export type PromptWorkflowUpdate =
	| {
			type: "progress";
			phase: string;
			text: string;
			request?: PromptRequestSummary;
	  }
	| { type: "chunk"; text: string; accumulatedText: string };

/** Compact prompt result returned to tools; large full text is stored by responseId. */
export interface PromptRunResult {
	provider: "gemini-acp";
	text: string;
	responseLength: number;
	truncated: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

export type PromptUpdateHandler = (
	update: PromptWorkflowUpdate,
) => void | Promise<void>;

/** Executes a plain text prompt through the configured local Gemini ACP provider. */
export async function runPrompt(
	options: PromptOptions,
	deps: PromptDeps = {},
	signal?: AbortSignal,
	onUpdate?: PromptUpdateHandler,
): Promise<PromptRunResult> {
	if (!options.prompt.trim()) {
		return promptError(
			"GEMINI_ACP_EMPTY_PROMPT",
			"input_validation",
			"Prompt text is required.",
		);
	}

	await onUpdate?.({
		type: "progress",
		phase: "provider_preflight",
		text: "Checking Gemini ACP configuration.",
	});
	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config =
		options.useDefaultConfig === false
			? loadedConfig
			: withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
		rootDir: options.rootDir,
		signal,
		authProbe: deps.authProbe,
		persistAuthConfirmation: options.config ? false : true,
	});
	if (preflight) return { ...emptyPromptResult(), error: preflight };

	const commandSettings = buildGeminiAcpCommandSettings(settings);
	const requestSummary = promptRequestSummary(
		options,
		geminiAcpModelLabel(settings, commandSettings),
	);
	const client =
		deps.geminiAcpClient ??
		(
			deps.geminiAcpClientFactory ??
			((settings) => getCachedGeminiAcpClient(settings, "prompt"))
		)(commandSettings);
	try {
		await onUpdate?.({
			type: "progress",
			phase: "provider_prompt",
			text: formatPromptRequestSummary(requestSummary),
			request: requestSummary,
		});
		const text = await client.prompt(
			{ prompt: options.prompt, cwd: options.cwd },
			signal,
			async (chunk) => {
				await onUpdate?.(chunk);
			},
		);
		return await compactPromptResult(text, options);
	} catch (cause) {
		return {
			...emptyPromptResult(),
			error: {
				...promptProviderError(
					isAbortError(cause) ? "GEMINI_ACP_ABORTED" : "GEMINI_ACP_FAILED",
					"provider_prompt",
					isAbortError(cause)
						? "Gemini ACP prompt was aborted."
						: cause instanceof Error
							? cause.message
							: "Gemini ACP prompt failed.",
					isAbortError(cause),
				),
				cause,
			},
		};
	}
}

async function compactPromptResult(
	text: string,
	options: PromptOptions,
): Promise<PromptRunResult> {
	const responseLength = text.length;
	const inlineLimit = options.inlineLimit ?? PROMPT_RESPONSE_INLINE_LIMIT;
	if (responseLength <= inlineLimit) {
		return {
			provider: "gemini-acp",
			text,
			responseLength,
			truncated: false,
		};
	}
	const stored = await storeResult(
		{ provider: "gemini-acp", prompt: options.prompt, text },
		{ rootDir: options.rootDir },
	);
	return {
		provider: "gemini-acp",
		text: `${text.slice(0, inlineLimit)}…`,
		responseLength,
		truncated: true,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function promptRequestSummary(
	options: PromptOptions,
	model: string,
): PromptRequestSummary {
	const summary = options.requestSummary ?? {
		toolName: "gemini_prompt" as const,
		action: "Sending prompt",
		arguments: { promptLength: options.prompt.length },
	};
	return {
		...summary,
		arguments: { ...summary.arguments, model },
	};
}

/** Formats sanitized prompt request metadata for visible progress text. */
export function formatPromptRequestSummary(
	summary: PromptRequestSummary,
): string {
	const args = Object.entries(summary.arguments ?? {}).flatMap(
		([key, value]) =>
			value === undefined ? [] : `${key} ${formatRequestArgument(value)}`,
	);
	const model = summary.arguments?.model;
	const withoutModel = args.filter((arg) => !arg.startsWith("model "));
	const subject = summary.subject
		? `: "${truncateSummaryText(summary.subject)}"`
		: "";
	const withArgs = withoutModel.length
		? ` with ${withoutModel.join(", ")}`
		: "";
	const via = model ? ` via ${formatRequestArgument(model)}` : "";
	return `${summary.action}${subject}${withArgs}${via}.`;
}

function truncateSummaryText(value: string): string {
	return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
}

function formatRequestArgument(
	value: Exclude<PromptRequestArgument, undefined>,
): string {
	return typeof value === "string" ? value : String(value);
}

function geminiAcpModelLabel(
	settings: GeminiAcpProviderSettings | undefined,
	commandSettings: GeminiAcpCommandSettings,
): string {
	return (
		settings?.model?.trim() ||
		modelFromArgs(commandSettings.args) ||
		"Gemini ACP default"
	);
}

function modelFromArgs(
	args: readonly string[] | undefined,
): string | undefined {
	if (!args) return undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === "--model" || arg === "-m") && args[index + 1]?.trim()) {
			return args[index + 1].trim();
		}
		if (arg?.startsWith("--model=")) {
			const value = arg.slice("--model=".length).trim();
			if (value) return value;
		}
	}
	return undefined;
}

function emptyPromptResult(): PromptRunResult {
	return {
		provider: "gemini-acp",
		text: "",
		responseLength: 0,
		truncated: false,
	};
}

function promptError(
	code: string,
	phase: string,
	message: string,
): PromptRunResult {
	return {
		...emptyPromptResult(),
		error: promptProviderError(code, phase, message),
	};
}

function promptProviderError(
	code: string,
	phase: string,
	message: string,
	retryable = false,
): StructuredError {
	return { code, phase, message, retryable, provider: "gemini-acp" };
}

function isAbortError(value: unknown): boolean {
	return value instanceof DOMException
		? value.name === "AbortError"
		: value instanceof Error && value.name === "AbortError";
}
