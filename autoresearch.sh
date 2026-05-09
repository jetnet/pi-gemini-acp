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

# Run benchmark with warm mode, default settings
# Use --json for machine-parseable output
bench_json=$(node scripts/bench.mjs \
	--mode warm \
	--runs 3 \
	--max-results 5 \
	--json 2>/dev/null) || {
	echo "METRIC totalMs_p50=999999"
	echo "METRIC promptMs_p50=999999"
	echo "METRIC results=0"
	exit 0
}

# Parse metrics from warm section
echo "$bench_json" | node --input-type=module -e '
import { readFileSync } from "node:fs";
const json = JSON.parse(readFileSync(0, "utf8"));
const warmSection = json.sections.find(s => s.mode === "warm");
if (!warmSection || !warmSection.stats) {
	process.stdout.write("METRIC totalMs_p50=999999\n");
	process.stdout.write("METRIC promptMs_p50=999999\n");
	process.stdout.write("METRIC initMs=999999\n");
	process.stdout.write("METRIC sessionMs=999999\n");
	process.stdout.write("METRIC results=0\n");
	process.exit(0);
}
const stats = warmSection.stats;
process.stdout.write("METRIC totalMs_p50=" + (stats.totalMs?.median ?? 999999) + "\n");
process.stdout.write("METRIC promptMs_p50=" + (stats.promptMs?.median ?? 999999) + "\n");
process.stdout.write("METRIC initMs=" + (stats.initMs?.median ?? 0) + "\n");
process.stdout.write("METRIC sessionMs=" + (stats.sessionMs?.median ?? 0) + "\n");
process.stdout.write("METRIC results=" + (warmSection.resultsCount ?? 0) + "\n");
'
