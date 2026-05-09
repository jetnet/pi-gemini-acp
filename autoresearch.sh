#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC meanMs=999999"
	echo "METRIC p50Ms=999999"
	echo "METRIC p95Ms=999999"
	echo "METRIC minMs=999999"
	echo "METRIC maxMs=999999"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Final validation: 20 runs with recommended configuration
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Use specific query (based on Exp #15 finding: specific is faster)
result_file=$(mktemp)
trap "rm -f $result_file" EXIT

node scripts/bench.mjs \
	--mode warm \
	--runs 20 \
	--max-results "$MAX_RESULTS" \
	--query "TypeScript ESM module resolution best practices" \
	--json > "$result_file" 2>/dev/null || {
	echo "METRIC meanMs=999999"
	echo "METRIC p50Ms=999999"
	echo "METRIC p95Ms=999999"
	echo "METRIC minMs=999999"
	echo "METRIC maxMs=999999"
	exit 0
}

# Parse: full distribution statistics
node --input-type=module -e '
import { readFileSync } from "fs";
const json = JSON.parse(readFileSync(process.argv[1], "utf8"));
const section = json.sections.find(s => s.mode === "warm");

if (!section?.runs || section.runs.length < 5) {
	process.stdout.write("METRIC meanMs=999999\n");
	process.stdout.write("METRIC p50Ms=999999\n");
	process.stdout.write("METRIC p95Ms=999999\n");
	process.stdout.write("METRIC minMs=999999\n");
	process.stdout.write("METRIC maxMs=999999\n");
	process.exit(0);
}

const times = section.runs.map(r => r.totalMs);
times.sort((a, b) => a - b);

const mean = times.reduce((s, v) => s + v, 0) / times.length;
const p50 = times[Math.floor(times.length * 0.5)];
const p95 = times[Math.floor(times.length * 0.95)];
const min = times[0];
const max = times[times.length - 1];

process.stdout.write("METRIC meanMs=" + Math.round(mean) + "\n");
process.stdout.write("METRIC p50Ms=" + Math.round(p50) + "\n");
process.stdout.write("METRIC p95Ms=" + Math.round(p95) + "\n");
process.stdout.write("METRIC minMs=" + Math.round(min) + "\n");
process.stdout.write("METRIC maxMs=" + Math.round(max) + "\n");

// Coefficient of variation
const variance = times.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / times.length;
const cv = Math.sqrt(variance) / mean;
process.stdout.write("METRIC cv=" + cv.toFixed(2) + "\n");
' "$result_file"
