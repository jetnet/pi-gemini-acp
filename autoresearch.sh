#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

# Quick syntax check: compile target files (fast fail)
npx tsc -p tsconfig.json --noEmit 2>/dev/null || {
	echo "METRIC totalMs_p50=999999"
	echo "METRIC promptMs_p50=999999"
	echo "METRIC results=0"
	echo "[autoresearch] ERROR: TypeScript compilation failed" >&2
	exit 0
}

# Configuration via env vars
MODE="${MODE:-warm}"
MAX_RESULTS="${MAX_RESULTS:-4}"
RUNS="${RUNS:-5}"
EARLY_STOP="${EARLY_STOP:-0}"
VARIANT="${VARIANT:-current}"
export PI_GEMINI_ACP_SEARCH_EARLY_STOP="$EARLY_STOP"

# Run benchmark with settings
bench_json=$(node scripts/bench.mjs \
	--mode "$MODE" \
	--runs "$RUNS" \
	--max-results "$MAX_RESULTS" \
	--prompt-variant "$VARIANT" \
	--json 2>/dev/null) || {
	echo "METRIC totalMs_p50=999999"
	echo "METRIC promptMs_p50=999999"
	echo "METRIC results=0"
	exit 0
}

# Parse metrics
echo "$bench_json" | node --input-type=module -e '
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync(0, "utf8"));
const section = json.sections[0];
if (!section || !section.summary) {
	process.stdout.write("METRIC totalMs_p50=999999\n");
	process.stdout.write("METRIC promptMs_p50=999999\n");
	process.stdout.write("METRIC initMs=999999\n");
	process.stdout.write("METRIC sessionMs=999999\n");
	process.stdout.write("METRIC results=0\n");
	process.exit(0);
}
const summary = section.summary;
process.stdout.write("METRIC totalMs_p50=" + (summary?.totalMs?.p50 ?? 999999) + "\n");
process.stdout.write("METRIC promptMs_p50=" + (summary?.promptMs?.p50 ?? 999999) + "\n");
process.stdout.write("METRIC initMs=" + (summary?.initializeMs?.p50 ?? 0) + "\n");
process.stdout.write("METRIC sessionMs=" + (summary?.sessionMs?.p50 ?? 0) + "\n");
const results = section.runs?.map(r => r.results) || [];
const avgResults = results.length > 0 ? results.reduce((s,v) => s+v, 0) / results.length : 0;
process.stdout.write("METRIC results=" + Math.round(avgResults) + "\n");
'
