#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
test -n "${DEEPSEEK_API_KEY:-}" || { echo 'DEEPSEEK_API_KEY is required' >&2; exit 1; }
# Same credentials schema as scripts/host-contract/run.sh; bump both with the pinned host.
CREDENTIALS_SCHEMA_VERSION="${CREDENTIALS_SCHEMA_VERSION:-1}"
HOST_TAG=conflict-eval
. "$REPO/scripts/host-common.sh"
host_init conflict-eval
trap host_cleanup EXIT
host_stage_and_pack
host_ensure
host_install_plugin host
# Serialize instead of interpolating a credential into configuration syntax.
(umask 077; node --input-type=module - "$HOMEDIR/.credentials.yaml" "$CREDENTIALS_SCHEMA_VERSION" <<'JS'
import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2], JSON.stringify({ version: Number(process.argv[3]), refs: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, records: {} }), { mode: 0o600 })
JS
)
REPORT="$(node -e 'console.log(require("node:crypto").randomUUID() + ".json")')"
PATCH="$TMP/eval.patch.yml"
node --input-type=module - "$PATCH" "$REPO/scripts/conflict-eval/plugin.ts" <<'JS'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
writeFileSync(process.argv[2], JSON.stringify([{ insert: [{ id: 'memory-conflict-eval', name: pathToFileURL(process.argv[3]).href, inject: ['llm', 'agentDefaultModel'] }] }]))
JS
# Keep host diagnostics local; model responses are saved in the ignored report.
code=0
env CONFLICT_EVAL_REPORT="$REPORT" DSH_HOME="$HOMEDIR" DSH_AGENTS_HOME="$TMP/agents" "$DSH" --profile host --patch "$PATCH" >"$LOGS/eval.log" 2>&1 || code=$?
if [ ! -f "$REPO/output/conflict-eval/$REPORT" ]; then
  echo 'Host exited without an evaluation report.' >&2
  exit 1
fi
# Print only evaluation tables, never raw host diagnostics.
node --input-type=module - "$REPO/output/conflict-eval" "$REPORT" <<'JS'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const file = process.argv[3]
if (!file) throw new Error('Host exited without an evaluation report')
const report = JSON.parse(readFileSync(join(dir, file), 'utf8'))
console.table(report.summary.classes)
console.log(JSON.stringify({ ...report.summary, verticalContradictions: report.verticalContradictions }))
console.log(join(dir, file))
JS

exit "$code"
