#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC optimizedMs=999999"
	echo "METRIC baselineMs=999999"
	echo "METRIC improvement=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Final sanity check: optimized (4, early-stop=0) vs baseline (5, early-stop=default)
trap 'rm -f /tmp/opt.json /tmp/base.json' EXIT

# Optimized config
PI_GEMINI_ACP_SEARCH_EARLY_STOP=0 node scripts/bench.mjs \
	--mode warm \
	--runs 5 \
	--max-results 4 \
	--json >/tmp/opt.json 2>/dev/null || {
	echo "METRIC optimizedMs=999999"
	echo "METRIC baselineMs=999999"
	echo "METRIC improvement=0"
	exit 0
}

# Baseline config (default early-stop, maxResults=5)
PI_GEMINI_ACP_SEARCH_EARLY_STOP=1 node scripts/bench.mjs \
	--mode warm \
	--runs 5 \
	--max-results 5 \
	--json >/tmp/base.json 2>/dev/null || {
	echo "METRIC optimizedMs=999999"
	echo "METRIC baselineMs=999999"
	echo "METRIC improvement=0"
	exit 0
}

# Compare
node --input-type=module -e '
import { readFileSync } from "fs";
const opt = JSON.parse(readFileSync("/tmp/opt.json", "utf8"));
const base = JSON.parse(readFileSync("/tmp/base.json", "utf8"));

const optSection = opt.sections.find(s => s.mode === "warm");
const baseSection = base.sections.find(s => s.mode === "warm");

if (!optSection?.summary || !baseSection?.summary) {
	process.stdout.write("METRIC optimizedMs=999999\n");
	process.stdout.write("METRIC baselineMs=999999\n");
	process.stdout.write("METRIC improvement=0\n");
	process.exit(0);
}

const optMs = optSection.summary.totalMs?.p50 || 999999;
const baseMs = baseSection.summary.totalMs?.p50 || 999999;
const improvement = ((baseMs - optMs) / baseMs * 100).toFixed(1);

process.stdout.write("METRIC optimizedMs=" + Math.round(optMs) + "\n");
process.stdout.write("METRIC baselineMs=" + Math.round(baseMs) + "\n");
process.stdout.write("METRIC improvement=" + improvement + "\n");
'
