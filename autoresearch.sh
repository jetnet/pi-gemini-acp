#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC firstQueryMs=999999"
	echo "METRIC repeatedQueryMs=999999"
	echo "METRIC cacheBenefit=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Test cache effectiveness: identical queries should be faster
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Run with identical query 3 times to test for caching
result_file=$(mktemp)
trap "rm -f $result_file" EXIT

node scripts/bench.mjs \
	--mode warm \
	--runs 5 \
	--max-results "$MAX_RESULTS" \
	--json > "$result_file" 2>/dev/null || {
	echo "METRIC firstQueryMs=999999"
	echo "METRIC repeatedQueryMs=999999"
	echo "METRIC cacheBenefit=0"
	exit 0
}

# Parse: compare run 1 (first) vs median of runs 2-5 (repeated)
node --input-type=module -e '
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync(process.argv[1], "utf8"));
const section = json.sections.find(s => s.mode === "warm");

if (!section?.runs || section.runs.length < 3) {
	process.stdout.write("METRIC firstQueryMs=999999\n");
	process.stdout.write("METRIC repeatedQueryMs=999999\n");
	process.stdout.write("METRIC cacheBenefit=0\n");
	process.exit(0);
}

// First run vs repeated runs (same query, warm process)
const first = section.runs[0].totalMs;
const subsequent = section.runs.slice(1).map(r => r.totalMs);
subsequent.sort((a, b) => a - b);
const repeated = subsequent[Math.floor(subsequent.length / 2)];

const benefit = first / repeated;

process.stdout.write("METRIC firstQueryMs=" + Math.round(first) + "\n");
process.stdout.write("METRIC repeatedQueryMs=" + Math.round(repeated) + "\n");
process.stdout.write("METRIC cacheBenefit=" + benefit.toFixed(2) + "\n");

// Also output all times for variance analysis
process.stdout.write("METRIC allTimes=" + section.runs.map(r => Math.round(r.totalMs)).join(",") + "\n");
' "$result_file"
