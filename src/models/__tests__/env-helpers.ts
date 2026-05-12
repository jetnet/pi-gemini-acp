/** @file Test helpers for environment manipulation. */

/** Temporarily sets an env var, awaits fn, then restores the original value. */
export async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env[key];
	process.env[key] = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
}
