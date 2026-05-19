/** @file Gemini ACP search parallelism environment controls. */

const SEARCH_PARALLEL_ENV = "PI_GEMINI_ACP_SEARCH_PARALLEL";

/** Returns whether live Gemini ACP searches may run concurrently (enabled by default). */
export function geminiAcpSearchParallelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const val = env[SEARCH_PARALLEL_ENV];
	if (val === undefined) return true;
	return !/^(?:0|false|no)$/iu.test(val);
}
