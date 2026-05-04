import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	searchSessionCwd,
	type GeminiAcpCommandSettings,
	type GeminiAcpPromptPart,
} from "../acp/client.js";
import {
	AcpProcessSession,
	type GeminiAcpProcessSessionFactory,
} from "../acp/session.js";
import { buildGeminiAcpCommandSettings } from "../acp/settings.js";
import { requirePermissionCapability } from "../config/permission-policy.js";
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
import type { GeminiAcpConfig, StructuredError } from "../types.js";
import {
	type ValidatedAnalyzeFile,
	validateAnalyzeFiles,
} from "./file-analyze-validation.js";
export { FILE_ANALYZE_MAX_BYTES } from "./file-analyze-validation.js";
export type { ValidatedAnalyzeFile } from "./file-analyze-validation.js";

export const FILE_ANALYZE_MAX_FILES = 5;
const FILE_ANALYZE_INLINE_LIMIT = 4_000;

/** Caller-provided local file analysis request, validated before ACP receives file references. */
export interface FileAnalyzeOptions {
	paths: string[];
	instructions: string;
	cwd?: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
}

/** Callback that may persist exact Gemini CLI folder trust after user consent. */
export type FileAnalyzeTrustHandler = (
	folderPath: string,
	signal?: AbortSignal,
) => Promise<boolean>;

/** Dependencies for tests and controlled ACP probing. */
export interface FileAnalyzeDeps {
	acpSessionFactory?: GeminiAcpProcessSessionFactory;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
	trustFolder?: FileAnalyzeTrustHandler;
}

/** Capability-gated file-analysis result. */
export interface FileAnalyzeResult {
	provider: "gemini-acp";
	text: string;
	files: ValidatedAnalyzeFile[];
	supported: boolean;
	transport: "resource_link" | "unsupported";
	responseLength?: number;
	truncated?: boolean;
	responseId?: string;
	fullOutputPath?: string;
	error?: StructuredError;
}

/**
 * Runs file analysis through Gemini ACP resource links after validating explicit paths.
 *
 * Only caller-provided regular files under `cwd` are referenced. Hidden paths,
 * symlinks, directories, secret-like names, and large files are rejected before
 * ACP sees them. Files are passed as ACP `resource_link` parts so Gemini CLI owns
 * provider transport while Pi keeps an allowlist for client-side read requests.
 */
export async function runFileAnalyze(
	options: FileAnalyzeOptions,
	deps: FileAnalyzeDeps = {},
	signal?: AbortSignal,
): Promise<FileAnalyzeResult> {
	const instructions = options.instructions.trim();
	if (!instructions) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_EMPTY_INSTRUCTIONS",
			"input_validation",
			"File analysis instructions are required.",
		);
	}

	if (!Array.isArray(options.paths) || options.paths.length === 0) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_EMPTY_PATHS",
			"input_validation",
			"At least one explicit file path is required.",
		);
	}

	if (options.paths.length > FILE_ANALYZE_MAX_FILES) {
		return fileAnalyzeError(
			"GEMINI_FILE_ANALYZE_TOO_MANY_FILES",
			"input_validation",
			`Analyze at most ${FILE_ANALYZE_MAX_FILES} explicitly provided files at once.`,
		);
	}

	if (signal?.aborted) return abortedResult();
	const validation = await validateAnalyzeFiles(options.paths, options.cwd);
	if (signal?.aborted) return abortedResult();
	if (validation.error)
		return { ...emptyFileAnalyzeResult(), error: validation.error };

	const loadedConfig =
		options.config ??
		configFromEnv(await loadConfig({ rootDir: options.rootDir }));
	const config = withDefaultGeminiAcpConfig(loadedConfig);
	const settings = config.providers?.["gemini-acp"];
	const preflight = await preflightGeminiAcpProvider(settings, {
		commandExists: deps.commandExists,
		requireSearchGrounding: false,
		rootDir: options.rootDir,
		signal,
		authProbe: deps.authProbe,
		persistAuthConfirmation: options.config ? false : true,
	});
	if (preflight) return { ...emptyFileAnalyzeResult(), error: preflight };
	const permissionError = requirePermissionCapability(
		settings?.permissionPolicy,
		"filesystemRead",
	);
	if (permissionError)
		return { ...emptyFileAnalyzeResult(), error: permissionError };

	const commandSettings = withAllowedReadPaths(
		buildGeminiAcpCommandSettings(settings),
		validation.files,
	);
	const sessionFactory = deps.acpSessionFactory ?? AcpProcessSession.start;
	const firstAttempt = await executeFileAnalyzeSession({
		commandSettings,
		files: validation.files,
		instructions,
		options,
		sessionFactory,
		sessionCwd: searchSessionCwd(undefined),
		signal,
	});
	if (!firstAttempt.error || !isTrustRequiredError(firstAttempt.error)) {
		return firstAttempt;
	}
	const trustedFolderPath = trustedFolderForFiles(
		validation.files,
		validation.rootDir,
	);
	const trusted = await requestFolderTrust(
		deps.trustFolder,
		trustedFolderPath,
		signal,
		firstAttempt,
	);
	if (trusted !== true) return trusted;
	return executeFileAnalyzeSession({
		commandSettings,
		files: validation.files,
		instructions,
		options,
		sessionFactory,
		sessionCwd: trustedFolderPath,
		signal,
	});
}

async function requestFolderTrust(
	trustFolder: FileAnalyzeTrustHandler | undefined,
	folderPath: string,
	signal: AbortSignal | undefined,
	fallback: FileAnalyzeResult,
): Promise<true | FileAnalyzeResult> {
	if (!trustFolder) return fallback;
	try {
		return (await trustFolder(folderPath, signal)) ? true : fallback;
	} catch (cause) {
		if (isAbortError(cause)) return abortedProviderResult(fallback.files);
		return {
			...emptyFileAnalyzeResult(),
			files: fallback.files,
			error: providerError(
				"GEMINI_ACP_TRUST_REQUIRED",
				"provider_prompt",
				trustRequiredMessage(
					cause instanceof Error
						? cause.message
						: "Gemini CLI folder trust was not saved.",
				),
			),
		};
	}
}

interface FileAnalyzeSessionAttempt {
	commandSettings: GeminiAcpCommandSettings;
	files: ValidatedAnalyzeFile[];
	instructions: string;
	options: FileAnalyzeOptions;
	sessionFactory: GeminiAcpProcessSessionFactory;
	sessionCwd: string;
	signal?: AbortSignal;
}

async function executeFileAnalyzeSession(
	attempt: FileAnalyzeSessionAttempt,
): Promise<FileAnalyzeResult> {
	let session: Awaited<ReturnType<GeminiAcpProcessSessionFactory>> | undefined;
	try {
		session = await attempt.sessionFactory(
			attempt.commandSettings,
			attempt.signal,
		);
		const initializeResult = await session.initialize();
		if (!initializeResult.promptCapabilities.embeddedContext) {
			return {
				...emptyFileAnalyzeResult(),
				files: attempt.files,
				error: providerError(
					"GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE",
					"capability_preflight",
					"Gemini ACP file/document resource-link support is not advertised by this ACP command.",
				),
			};
		}
		const sessionId = await session.newSession(attempt.sessionCwd);
		const text = await session.prompt(
			sessionId,
			fileAnalyzePromptParts(attempt.instructions, attempt.files),
			undefined,
			{ signal: attempt.signal },
		);
		return await compactFileAnalyzeResult(text, attempt.files, attempt.options);
	} catch (cause) {
		return {
			...emptyFileAnalyzeResult(),
			files: attempt.files,
			error: providerError(
				providerErrorCode(cause),
				"provider_prompt",
				providerErrorMessage(cause),
			),
		};
	} finally {
		await session?.close();
	}
}

function trustedFolderForFiles(
	files: ValidatedAnalyzeFile[],
	rootDir: string,
): string {
	return files.length === 1 ? path.dirname(files[0].resolvedPath) : rootDir;
}

function fileAnalyzePromptParts(
	instructions: string,
	files: ValidatedAnalyzeFile[],
): GeminiAcpPromptPart[] {
	return [
		{
			type: "text",
			text: [
				"Analyze only the attached explicit file resource links.",
				"Do not inspect unrelated workspace files.",
				`Instructions: ${instructions}`,
				"Files:",
				...files.map(
					(file) =>
						`- @${file.relativePath} (${file.mimeType}, ${file.sizeBytes} bytes)`,
				),
			].join("\n"),
		},
		...files.map((file) => ({
			type: "resource_link" as const,
			uri: pathToFileURL(file.resolvedPath).href,
			name: file.relativePath,
			title: file.path,
			mimeType: file.mimeType,
			size: file.sizeBytes,
		})),
	];
}

async function compactFileAnalyzeResult(
	text: string,
	files: ValidatedAnalyzeFile[],
	options: FileAnalyzeOptions,
): Promise<FileAnalyzeResult> {
	const responseLength = text.length;
	if (responseLength <= FILE_ANALYZE_INLINE_LIMIT) {
		return {
			provider: "gemini-acp",
			text,
			files,
			supported: true,
			transport: "resource_link",
			responseLength,
			truncated: false,
		};
	}
	const stored = await storeResult(
		{ provider: "gemini-acp", tool: "gemini_file_analyze", files, text },
		{ rootDir: options.rootDir },
	);
	return {
		provider: "gemini-acp",
		text: `${text.slice(0, FILE_ANALYZE_INLINE_LIMIT)}…`,
		files,
		supported: true,
		transport: "resource_link",
		responseLength,
		truncated: true,
		responseId: stored.responseId,
		fullOutputPath: stored.path,
	};
}

function withAllowedReadPaths(
	settings: GeminiAcpCommandSettings,
	files: ValidatedAnalyzeFile[],
): GeminiAcpCommandSettings {
	return {
		...settings,
		allowedReadPaths: files.map((file) => file.resolvedPath),
	};
}

function fileAnalyzeError(
	code: string,
	phase: string,
	message: string,
): FileAnalyzeResult {
	return {
		...emptyFileAnalyzeResult(),
		error: providerError(code, phase, message),
	};
}

function abortedResult(): FileAnalyzeResult {
	return fileAnalyzeError(
		"GEMINI_ACP_ABORTED",
		"input_validation",
		"Gemini ACP file analysis was aborted before ACP received file references.",
	);
}

function abortedProviderResult(
	files: ValidatedAnalyzeFile[],
): FileAnalyzeResult {
	return {
		...emptyFileAnalyzeResult(),
		files,
		error: providerError(
			"GEMINI_ACP_ABORTED",
			"provider_prompt",
			"Gemini ACP file analysis was aborted.",
		),
	};
}

function emptyFileAnalyzeResult(): FileAnalyzeResult {
	return {
		provider: "gemini-acp",
		text: "",
		files: [],
		supported: false,
		transport: "unsupported",
	};
}

function providerError(
	code: string,
	phase: string,
	message: string,
): StructuredError {
	return {
		code,
		phase,
		message,
		retryable: code === "GEMINI_ACP_ABORTED",
		provider: "gemini-acp",
	};
}

function providerErrorCode(cause: unknown): string {
	if (isAbortError(cause)) return "GEMINI_ACP_ABORTED";
	if (isTrustRequiredCause(cause)) return "GEMINI_ACP_TRUST_REQUIRED";
	return "GEMINI_ACP_FAILED";
}

function providerErrorMessage(cause: unknown): string {
	if (isAbortError(cause)) return "Gemini ACP file analysis was aborted.";
	const message = cause instanceof Error ? cause.message : undefined;
	if (message && isTrustRequiredText(message))
		return trustRequiredMessage(message);
	return message ?? "Gemini ACP file analysis failed.";
}

function isTrustRequiredError(error: StructuredError): boolean {
	return error.code === "GEMINI_ACP_TRUST_REQUIRED";
}

function isAbortError(cause: unknown): boolean {
	return cause instanceof DOMException
		? cause.name === "AbortError"
		: cause instanceof Error && cause.name === "AbortError";
}

function isTrustRequiredCause(cause: unknown): boolean {
	return cause instanceof Error && isTrustRequiredText(cause.message);
}

function isTrustRequiredText(message: string): boolean {
	return /trust|trusted|untrusted|trusted directory|skip-trust|GEMINI_CLI_TRUST_WORKSPACE/iu.test(
		message,
	);
}

function trustRequiredMessage(message: string): string {
	return `${message}\n\nGemini CLI appears to require folder trust for this ACP session. In interactive Pi, approve the trust prompt when offered; otherwise run /gemini-config trust or trust the exact folder in Gemini CLI, then retry.`;
}
