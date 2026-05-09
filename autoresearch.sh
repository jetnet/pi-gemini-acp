#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC freshMs=999999"
	echo "METRIC warmMs=999999"
	echo "METRIC benefit=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Test fresh vs warm mode comparison
MAX_RESULTS="${MAX_RESULTS:-4}"
EARLY_STOP="${EARLY_STOP:-0}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Run both modes and save to temp files
fresh_file=$(mktemp)
warm_file=$(mktemp)
trap "rm -f $fresh_file $warm_file" EXIT

node scripts/bench.mjs \
	--mode fresh \
	--runs 3 \
	--max-results "$MAX_RESULTS" \
	--json > "$fresh_file" 2>/dev/null || {
	echo "METRIC freshMs=999999"
	echo "METRIC warmMs=999999"
	echo "METRIC benefit=0"
	exit 0
}

node scripts/bench.mjs \
	--mode warm \
	--runs 3 \
	--max-results "$MAX_RESULTS" \
	--json > "$warm_file" 2>/dev/null || {
	echo "METRIC freshMs=999999"
	echo "METRIC warmMs=999999"
	echo "METRIC benefit=0"
	exit 0
}

# Parse and compare
node --input-type=module -e '
import { readFileSync } from "node:fs";
const fresh = JSON.parse(readFileSync(process.argv[1], "utf8"));
const warm = JSON.parse(readFileSync(process.argv[2], "utf8"));

const freshSection = fresh.sections.find(s => s.mode === "fresh");
const warmSection = warm.sections.find(s => s.mode === "warm");

if (!freshSection?.summary || !warmSection?.summary) {
	process.stdout.write("METRIC freshMs=999999\n");
	process.stdout.write("METRIC warmMs=999999\n");
	process.stdout.write("METRIC benefit=0\n");
	process.exit(0);
}

const freshMs = freshSection.summary.totalMs?.p50 || 999999;
const warmMs = warmSection.summary.totalMs?.p50 || 999999;
const benefit = freshMs / warmMs;

process.stdout.write("METRIC freshMs=" + Math.round(freshMs) + "\n");
process.stdout.write("METRIC warmMs=" + Math.round(warmMs) + "\n");
process.stdout.write("METRIC benefit=" + benefit.toFixed(2) + "\n");
' "$fresh_file" "$warm_file"
