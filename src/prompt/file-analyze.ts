import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
	GeminiAcpCommandSettings,
	GeminiAcpPromptPart,
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

export const FILE_ANALYZE_MAX_FILES = 5;
export const FILE_ANALYZE_MAX_BYTES = 1_000_000;
const FILE_ANALYZE_INLINE_LIMIT = 4_000;

/** Caller-provided local file analysis request, validated before ACP receives file references. */
export interface FileAnalyzeOptions {
	paths: string[];
	instructions: string;
	cwd?: string;
	config?: GeminiAcpConfig;
	rootDir?: string;
}

/** Dependencies for tests and controlled ACP probing. */
export interface FileAnalyzeDeps {
	acpSessionFactory?: GeminiAcpProcessSessionFactory;
	commandExists?: StatusCommandChecker;
	authProbe?: GeminiAcpAuthProbe;
}

/** File metadata that passed the conservative file-analysis safety checks. */
export interface ValidatedAnalyzeFile {
	path: string;
	resolvedPath: string;
	relativePath: string;
	sizeBytes: number;
	mimeType: string;
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
	let session: Awaited<ReturnType<GeminiAcpProcessSessionFactory>> | undefined;
	try {
		session = await sessionFactory(commandSettings, signal);
		const initializeResult = await session.initialize();
		if (!initializeResult.promptCapabilities.embeddedContext) {
			return {
				...emptyFileAnalyzeResult(),
				files: validation.files,
				error: providerError(
					"GEMINI_ACP_FILE_ANALYSIS_UNAVAILABLE",
					"capability_preflight",
					"Gemini ACP file/document resource-link support is not advertised by this ACP command.",
				),
			};
		}
		const sessionId = await session.newSession(validation.rootDir);
		const text = await session.prompt(
			sessionId,
			fileAnalyzePromptParts(instructions, validation.files),
		);
		return await compactFileAnalyzeResult(text, validation.files, options);
	} catch (cause) {
		return {
			...emptyFileAnalyzeResult(),
			files: validation.files,
			error: providerError(
				isAbortError(cause) ? "GEMINI_ACP_ABORTED" : "GEMINI_ACP_FAILED",
				"provider_prompt",
				isAbortError(cause)
					? "Gemini ACP file analysis was aborted."
					: cause instanceof Error
						? cause.message
						: "Gemini ACP file analysis failed.",
			),
		};
	} finally {
		await session?.close();
	}
}

async function validateAnalyzeFiles(
	paths: string[],
	cwd = process.cwd(),
): Promise<{
	rootDir: string;
	files: ValidatedAnalyzeFile[];
	error?: StructuredError;
}> {
	const rootDir = path.resolve(cwd);
	const seen = new Set<string>();
	const files: ValidatedAnalyzeFile[] = [];
	for (const inputPath of paths) {
		const trimmed = inputPath.trim();
		if (!trimmed) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_EMPTY_PATH",
					"File paths must be non-empty strings.",
				),
			};
		}
		const resolvedPath = path.resolve(rootDir, trimmed);
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);

		const unsafeReason = unsafePathReason(trimmed, resolvedPath, rootDir);
		if (unsafeReason) return { rootDir, files, error: unsafeReason };

		let stat;
		try {
			stat = await lstat(resolvedPath);
		} catch {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_FILE_NOT_FOUND",
					`File was not found: ${trimmed}`,
				),
			};
		}
		if (stat.isDirectory()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_DIRECTORY_REJECTED",
					`Directories are not supported: ${trimmed}`,
				),
			};
		}
		if (stat.isSymbolicLink()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_SYMLINK_REJECTED",
					`Symbolic links are rejected by default: ${trimmed}`,
				),
			};
		}
		if (!stat.isFile()) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_NOT_A_FILE",
					`Only regular files are supported: ${trimmed}`,
				),
			};
		}
		if (stat.size > FILE_ANALYZE_MAX_BYTES) {
			return {
				rootDir,
				files,
				error: inputError(
					"GEMINI_FILE_ANALYZE_FILE_TOO_LARGE",
					`Files must be ${FILE_ANALYZE_MAX_BYTES} bytes or smaller: ${trimmed}`,
				),
			};
		}
		const relativePath = toPosix(path.relative(rootDir, resolvedPath));
		files.push({
			path: trimmed,
			resolvedPath,
			relativePath,
			sizeBytes: stat.size,
			mimeType: mimeTypeForPath(resolvedPath),
		});
	}
	return { rootDir, files };
}

function unsafePathReason(
	inputPath: string,
	resolvedPath: string,
	rootDir: string,
): StructuredError | undefined {
	if (!isWithinRoot(resolvedPath, rootDir)) {
		return inputError(
			"GEMINI_FILE_ANALYZE_OUTSIDE_CWD_REJECTED",
			`File analysis paths must resolve under cwd: ${inputPath}`,
		);
	}
	const inputSegments = path
		.normalize(inputPath)
		.split(path.sep)
		.filter(Boolean);
	if (inputSegments.some((segment) => segment.startsWith("."))) {
		return inputError(
			"GEMINI_FILE_ANALYZE_HIDDEN_PATH_REJECTED",
			`Hidden files or directories are rejected by default: ${inputPath}`,
		);
	}
	const basename = path.basename(resolvedPath).toLowerCase();
	if (secretLikePath(basename, resolvedPath.toLowerCase())) {
		return inputError(
			"GEMINI_FILE_ANALYZE_SECRET_PATH_REJECTED",
			`Secret-like files are rejected by default: ${inputPath}`,
		);
	}
	return undefined;
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
			uri: `file://${file.relativePath}`,
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

function mimeTypeForPath(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".md":
		case ".markdown":
			return "text/markdown";
		case ".json":
			return "application/json";
		case ".html":
		case ".htm":
			return "text/html";
		case ".ts":
		case ".tsx":
		case ".js":
		case ".jsx":
		case ".css":
		case ".yaml":
		case ".yml":
		case ".txt":
			return "text/plain";
		default:
			return "text/plain";
	}
}

function isWithinRoot(filePath: string, rootDir: string): boolean {
	const relative = path.relative(rootDir, filePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

function secretLikePath(basename: string, lowerPath: string): boolean {
	return (
		/^(id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys)$/u.test(
			basename,
		) ||
		/\.(pem|p12|pfx|key|keystore|jks)$/u.test(basename) ||
		/(^|[-_.])(secret|token|password|passwd|credential|credentials|api[-_]?key)([-_.]|$)/u.test(
			basename,
		) ||
		/(^|\/)\.?(aws|config)\/credentials$/u.test(lowerPath) ||
		/(^|\/)kubeconfig$/u.test(lowerPath)
	);
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

function inputError(code: string, message: string): StructuredError {
	return providerError(code, "input_validation", message);
}

function abortedResult(): FileAnalyzeResult {
	return fileAnalyzeError(
		"GEMINI_ACP_ABORTED",
		"input_validation",
		"Gemini ACP file analysis was aborted before ACP received file references.",
	);
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
	return { code, phase, message, retryable: false, provider: "gemini-acp" };
}

function isAbortError(cause: unknown): boolean {
	return cause instanceof DOMException && cause.name === "AbortError";
}
