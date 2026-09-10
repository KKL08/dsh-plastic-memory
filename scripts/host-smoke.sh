#!/usr/bin/env bash
# R0 install smoke: prove the PUBLISHED-shape package installs and loads in a
# fresh, real DeepSeek Harness (dsh) host, with no API key and no writes to the
# user's ~/.dsh. Everything runs under an isolated DSH_HOME in a temp dir.
#
# Steps: build lib -> stage the published shape -> npm pack -> pinned dsh host
# (cached per version) -> `dsh plugin --profile smoke add <tgz>` -> --dump-config
# has a `name: dsh-plastic-memory` layer -> short smoke-profile boot -> pure-Node
# import of the installed lib/index.js exports apply/inject/name/Config.
#
# Why the boot step: on dsh 0.1.5 the shared `$DSH_HOME/profiles/node_modules`
# fallback links (what lets plain Node resolve the host packages the plugin
# imports, e.g. @deepseek-ai/schemastery) are written by healProfilesModuleFallback
# only during a real profile boot — `plugin add` and `--dump-config` don't create
# them. So the pure-Node import check must run after one real boot, not straight
# after install (that ordering worked on rc.2, where the links already existed at
# dump-config time). The smoke profile has no app that exits on its own, so we
# launch the host, poll for the fallback link, then terminate it.
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

# Boot the smoke profile once. Two things only a real boot produces: the
# profiles/node_modules host-package fallback (healed at profile boot), and the
# plugin's own apply() starting inside the host, observable as the memories/global
# directory it creates early on (the host logs nothing without a TTY, so boot.log stays
# empty on success). The profile has no app to exit on, so poll for both marks,
# then stop the host (TERM, then KILL as a backstop). If the host dies first —
# e.g. the plugin fails to load — host_cleanup tails boot.log.
STEP=boot
FALLBACK="$HOMEDIR/profiles/node_modules/@deepseek-ai/schemastery"
APPLIED="$HOMEDIR/memories/global"
BOOT_T0=$SECONDS
env DSH_HOME="$HOMEDIR" "$DSH" --profile smoke >"$LOGS/boot.log" 2>&1 &
BOOT_PID=$!
disown "$BOOT_PID" 2>/dev/null || true   # we reap it by signal; keep job control quiet
BOOT_READY=""
for _ in $(seq 1 300); do          # up to ~30s for fallback heal + plugin apply
  if [ -e "$FALLBACK" ] && [ -d "$APPLIED" ]; then BOOT_READY=1; break; fi
  kill -0 "$BOOT_PID" 2>/dev/null || break   # host died before both marks appeared
  sleep 0.1
done
kill -TERM "$BOOT_PID" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.1; done
kill -KILL "$BOOT_PID" 2>/dev/null || true
if [ -z "$BOOT_READY" ]; then
  [ -e "$FALLBACK" ] || echo "$HOST_TAG: smoke boot did not create the profiles/node_modules fallback link ($FALLBACK)" >&2
  [ -d "$APPLIED" ] || echo "$HOST_TAG: smoke boot never ran the plugin's apply() ($APPLIED missing)" >&2
  exit 1
fi
echo "$HOST_TAG: step boot ok ($((SECONDS - BOOT_T0))s)"

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
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, tgz installed, dump-config layer present, smoke boot started the plugin's apply() in the real host (full load is host:contract's job), lib import exports apply/inject/name/Config, ~/.dsh untouched"
