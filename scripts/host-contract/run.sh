#!/usr/bin/env bash
# R1 host contract: boot a fresh, real dsh host with the packed plugin and a
# sibling verify plugin that drives the nine memory_* tools through the real
# ctx.tools with synthetic sessions. No LLM is needed for H1–H9; H10/H11 run
# only when DEEPSEEK_API_KEY is set and the host can pick a default model,
# otherwise they are reported as SKIPPED. Never touches ~/.dsh.
#
#   scripts/host-contract/run.sh              run (temp dir removed on exit)
#   HOST_SMOKE_KEEP=1 ...                     keep the temp dir (logs, DSH_HOME) — with a key set,
#                                             the kept dir holds an owner-only .credentials.yaml
#   DEEPSEEK_API_KEY=... ...                  enable the two semantic-layer cases
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Schema version of $DSH_HOME/.credentials.yaml understood by the pinned host
# (refs.<NAME> holds the secret); bump alongside the pinned host if it changes.
CREDENTIALS_SCHEMA_VERSION="${CREDENTIALS_SCHEMA_VERSION:-1}"
HOST_TAG="host-contract"
. "$REPO/scripts/host-common.sh"

host_init host-contract
trap host_cleanup EXIT
SECONDS=0
echo "$HOST_TAG: pinned dsh host = @deepseek-ai/dsh@$PINNED"
echo "$HOST_TAG: temp root       = $TMP"

host_stage_and_pack
host_ensure
MARKER="$TMP/.marker"; : > "$MARKER"
host_install_plugin host

PATCH="$TMP/verify.cordis.patch.yml"
sed "s#__VERIFY_URL__#file://$REPO/scripts/host-contract/verify-plugin.ts#" "$REPO/scripts/host-contract/verify.cordis.patch.yml" > "$PATCH"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  # rc.2's credentials service does not fall back to the environment; give the
  # isolated home its own credentials file (never copied from the real ~/.dsh).
  ( umask 077; printf 'version: %s\nrefs:\n  DEEPSEEK_API_KEY: "%s"\nrecords: {}\n' "$CREDENTIALS_SCHEMA_VERSION" "$DEEPSEEK_API_KEY" > "$HOMEDIR/.credentials.yaml" )
  chmod 600 "$HOMEDIR/.credentials.yaml"  # the host refuses a credentials file readable beyond its owner
fi
RESULTS="$TMP/results.json"
HANDOFF="$TMP/handoff.json"
set +e
env DSH_HOME="$HOMEDIR" HOST_CONTRACT_OUT="$RESULTS" HOST_CONTRACT_HANDOFF="$HANDOFF" "$DSH" --profile host --patch "$PATCH" >"$LOGS/boot.log" 2>&1
code=$?
set -e
STEP=boot
if [ ! -f "$RESULTS" ]; then
  echo "$HOST_TAG: host exited ($code) without results; boot.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/boot.log" | head -n 10 >&2 || true
  exit 1
fi
# Second boot of the same isolated home (H12): the record restored in H7 must come
# back from disk in a fresh host process, and its snapshot must survive the restart.
RESULTS2="$TMP/results-restart.json"
STEP=restart
if [ ! -f "$HANDOFF" ]; then
  echo "$HOST_TAG: first boot exited ($code) without a handoff file; restart check cannot run. boot.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/boot.log" | head -n 10 >&2 || true
  exit 1
fi
set +e
env DSH_HOME="$HOMEDIR" HOST_CONTRACT_OUT="$RESULTS2" HOST_CONTRACT_HANDOFF="$HANDOFF" HOST_CONTRACT_PHASE=restart "$DSH" --profile host --patch "$PATCH" >"$LOGS/restart.log" 2>&1
code2=$?
set -e
if [ ! -f "$RESULTS2" ]; then
  echo "$HOST_TAG: restarted host exited ($code2) without results; restart.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/restart.log" | head -n 10 >&2 || true
  exit 1
fi
node -e '
const fs = require("fs");
const r = [...JSON.parse(fs.readFileSync(process.argv[1], "utf8")), ...JSON.parse(fs.readFileSync(process.argv[2], "utf8"))];
for (const o of r) console.log(`${o.ok ? (o.skipped ? "SKIP" : "PASS") : "FAIL"}  ${o.id}  ${o.detail}`);
const fails = r.filter(o => !o.ok).length, skips = r.filter(o => o.skipped).length;
console.log(`host-contract: ${r.length - fails - skips} passed, ${skips} skipped, ${fails} failed`);
process.exit(fails ? 1 : 0);
' "$RESULTS" "$RESULTS2"
# The verify plugin exits the host with 0 only when every case passed; a host that
# wrote the results and then died on shutdown must not be reported as PASS.
if [ "$code" -ne 0 ] || [ "$code2" -ne 0 ]; then
  echo "$HOST_TAG: host exited (first=$code restart=$code2) after writing results; log tails:" >&2
  tail -n 20 "$LOGS/boot.log" "$LOGS/restart.log" >&2
  exit 1
fi
host_assert_isolated
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, ~/.dsh untouched"
