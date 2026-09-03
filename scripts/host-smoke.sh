#!/usr/bin/env bash
# R0 install smoke: prove the PUBLISHED-shape package installs and loads in a
# fresh, real DeepSeek Harness (dsh) host, with no API key and no writes to the
# user's ~/.dsh. Everything runs under an isolated DSH_HOME in a temp dir.
#
# Steps: build lib -> stage the published shape -> npm pack -> pinned dsh host
# (cached per version) -> `dsh plugin --profile smoke add <tgz>` -> --dump-config
# has a `name: dsh-plastic-memory` layer -> pure-Node import of the installed
# lib/index.js exports apply/inject/name/Config.
#
# What this deliberately does NOT exercise: no LLM call, no tool invocation, no
# session run. It is an install/load/config contract check only; the host
# contract check (scripts/host-contract/run.sh) covers tool behavior.
#
#   scripts/host-smoke.sh          run the smoke (temp dir removed on exit)
#   HOST_SMOKE_KEEP=1 scripts/...  keep the temp dir for debugging
#   HOST_SMOKE_CACHE=<dir>         where the pinned host install is cached between runs
#                                  (default ~/.cache/dsh-plastic-memory)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST_TAG="host-smoke"
. "$REPO/scripts/host-common.sh"

host_init host-smoke
trap host_cleanup EXIT
SECONDS=0
echo "$HOST_TAG: pinned dsh host = @deepseek-ai/dsh@$PINNED"
echo "$HOST_TAG: temp root       = $TMP"

host_stage_and_pack
host_ensure
MARKER="$TMP/.marker"; : > "$MARKER"
host_install_plugin smoke

host_run dump-config env DSH_HOME="$HOMEDIR" "$DSH" --profile smoke --dump-config
if ! grep -Eq 'name:[[:space:]]*dsh-plastic-memory' "$LOGS/dump-config.log"; then
  STEP=dump-config
  echo "$HOST_TAG: dump-config has no 'name: dsh-plastic-memory' layer" >&2
  exit 1
fi

IDX="$(find "$HOMEDIR" -type f -path '*dsh-plastic-memory/lib/index.js' 2>/dev/null | head -n 1)"
[ -n "$IDX" ] || { STEP=import; echo "$HOST_TAG: installed lib/index.js not found under $HOMEDIR" >&2; exit 1; }
host_run import node -e '
import(process.argv[1]).then(m => {
  const need = ["apply","inject","name","Config"];
  const missing = need.filter(k => !(k in m));
  if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
}).catch(e => { console.error(e); process.exit(1); });
' "$IDX"

host_assert_isolated
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, tgz installed, dump-config layer present, lib import exports apply/inject/name/Config, ~/.dsh untouched"
