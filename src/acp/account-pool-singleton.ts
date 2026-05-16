import type { GeminiAcpConfig, GeminiAcpProviderSettings } from "../types.ts";
import { resolveAccountsConfig, type ResolvedAccountsConfig } from "./account-config.ts";
import { AccountPool } from "./account-pool.ts";
import type { GeminiAcpCommandSettings } from "./client.ts";
import { buildGeminiAcpCommandSettings } from "./settings.ts";

let activePool: AccountPool | undefined;
let activeConfig: ResolvedAccountsConfig | undefined;

export function getAccountPool(config: GeminiAcpConfig): AccountPool | undefined {
	const resolved = resolveAccountsConfig(config.providers?.accounts);
	if (!resolved) {
		activePool = undefined;
		activeConfig = undefined;
		return undefined;
	}
	if (activePool && activeConfig === resolved) return activePool;
	activePool = new AccountPool(resolved);
	activeConfig = resolved;
	return activePool;
}

export function hasAccountPool(config: GeminiAcpConfig): boolean {
	return resolveAccountsConfig(config.providers?.accounts) !== undefined;
}

export async function executeWithAccountPool<T>(
	config: GeminiAcpConfig,
	settings: GeminiAcpProviderSettings | undefined,
	operation: (commandSettings: GeminiAcpCommandSettings) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const pool = getAccountPool(config);
	if (!pool) {
		return await operation(buildGeminiAcpCommandSettings(settings));
	}
	return await pool.execute(async (accountEnv) => {
		const commandSettings = buildGeminiAcpCommandSettings(settings, accountEnv);
		return await operation(commandSettings);
	}, signal);
}

export function getAccountPoolStatus(config: GeminiAcpConfig) {
	const pool = getAccountPool(config);
	if (!pool) return;
	return pool.getStatus();
}

export function clearAccountPool(): void {
	activePool?.clearCooldowns();
	activePool = undefined;
	activeConfig = undefined;
}
