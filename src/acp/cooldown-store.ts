/** @file File-backed cooldown persistence for multi-call account pool failover. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir, resolveStoragePaths, type StorageOptions } from "../storage/paths.ts";
import type { CooldownEntry } from "./account-pool.ts";

const COOLDOWN_FILE = "account-cooldowns.json";

export interface CooldownStore {
	load(): Promise<Map<string, CooldownEntry>>;
	save(cooldowns: Map<string, CooldownEntry>): Promise<void>;
}

export function createFileCooldownStore(options: StorageOptions = {}): CooldownStore {
	const filePath = path.join(resolveStoragePaths(options).config, COOLDOWN_FILE);
	return {
		async load(): Promise<Map<string, CooldownEntry>> {
			try {
				const raw = await readFile(filePath, "utf8");
				const entries = JSON.parse(raw) as CooldownEntry[];
				const now = Date.now();
				const map = new Map<string, CooldownEntry>();
				for (const entry of entries) {
					if (
						typeof entry.accountName === "string" &&
						typeof entry.coolUntil === "number" &&
						entry.coolUntil > now
					) {
						map.set(entry.accountName, entry);
					}
				}
				return map;
			} catch {
				return new Map();
			}
		},
		async save(cooldowns: Map<string, CooldownEntry>): Promise<void> {
			try {
				const now = Date.now();
				// Merge with on-disk cooldowns so concurrent Pi processes don't clobber each other.
				const merged = await this.load();
				for (const [name, entry] of cooldowns) {
					if (entry.coolUntil > now) merged.set(name, entry);
				}
				await ensureDir(resolveStoragePaths(options).config);
				const active = [...merged.values()].filter((e) => e.coolUntil > now);
				await writeFile(filePath, JSON.stringify(active, null, 2), { mode: 0o600 });
			} catch {
				// Non-fatal: cooldown won't persist but failover still works within this call.
			}
		},
	};
}
