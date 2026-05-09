#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC simpleMs=999999"
	echo "METRIC complexMs=999999"
	echo "METRIC ratio=1"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Test query complexity impact
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

QUERY_SIMPLE="weather"
QUERY_COMPLEX="Amsterdam Netherlands current weather temperature conditions forecast humidity wind"

# Run simple query
simple_file=$(mktemp)
trap "rm -f $simple_file" EXIT

node scripts/bench.mjs \
	--mode warm \
	--runs 3 \
	--max-results "$MAX_RESULTS" \
	--query "$QUERY_SIMPLE" \
	--json > "$simple_file" 2>/dev/null || {
	echo "METRIC simpleMs=999999"
	echo "METRIC complexMs=999999"
	echo "METRIC ratio=1"
	exit 0
}

# Run complex query
complex_file=$(mktemp)
trap "rm -f $simple_file $complex_file" EXIT

node scripts/bench.mjs \
	--mode warm \
	--runs 3 \
	--max-results "$MAX_RESULTS" \
	--query "$QUERY_COMPLEX" \
	--json > "$complex_file" 2>/dev/null || {
	echo "METRIC simpleMs=999999"
	echo "METRIC complexMs=999999"
	echo "METRIC ratio=1"
	exit 0
}

# Parse and compare
node --input-type=module -e '
import { readFileSync } from "node:fs";
const simple = JSON.parse(readFileSync(process.argv[1], "utf8"));
const complex = JSON.parse(readFileSync(process.argv[2], "utf8"));

const simpleSection = simple.sections.find(s => s.mode === "warm");
const complexSection = complex.sections.find(s => s.mode === "warm");

if (!simpleSection?.summary || !complexSection?.summary) {
	process.stdout.write("METRIC simpleMs=999999\n");
	process.stdout.write("METRIC complexMs=999999\n");
	process.stdout.write("METRIC ratio=1\n");
	process.exit(0);
}

const simpleMs = simpleSection.summary.totalMs?.p50 || 999999;
const complexMs = complexSection.summary.totalMs?.p50 || 999999;
const ratio = complexMs / simpleMs;

process.stdout.write("METRIC simpleMs=" + Math.round(simpleMs) + "\n");
process.stdout.write("METRIC complexMs=" + Math.round(complexMs) + "\n");
process.stdout.write("METRIC ratio=" + ratio.toFixed(2) + "\n");
' "$simple_file" "$complex_file"
