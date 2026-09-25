#!/usr/bin/env bash
# R0 install smoke: prove the PUBLISHED-shape package installs and loads in a
# fresh, real DeepSeek Harness (dsh) host, with no API key and no writes to the
# user's ~/.dsh. Everything runs under an isolated DSH_HOME in a temp dir.
#
# Steps: build lib -> stage the published shape -> npm pack -> pinned dsh host
# (cached per version) -> `dsh plugin --profile smoke add <tgz>` -> --dump-config
# has a `name: dsh-plastic-memory` layer -> short smoke-profile boot -> static
# checks on the installed lib/ (`node --check`, no relative import left on .ts).
#
# Why the boot step: it is the only proof that the published package loads inside
# the real host — the plugin's apply() runs, observable as the memories/global
# directory it creates. Since dsh 0.1.7 the host resolves its own packages (e.g.
# @deepseek-ai/schemastery, which the plugin imports) from an in-memory runtime
# table and no longer writes `$DSH_HOME/profiles/node_modules` fallback links, so
# plain Node outside the host cannot resolve them and no pure-Node import of lib/
# is attempted. The static checks guard the build output instead. The smoke
# profile has no app that exits on its own, so we launch the host, poll for the
# apply() mark, then terminate it.
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

# Boot the smoke profile once and wait for the plugin's own apply() to start inside
# the host, observable as the memories/global directory it creates early on (the
# host logs nothing without a TTY, so boot.log stays empty on success). The profile
# has no app to exit on, so poll for that mark, then stop the host (TERM, then KILL
# as a backstop). If the host dies first — e.g. the plugin fails to load —
# host_cleanup tails boot.log.
STEP=boot
APPLIED="$HOMEDIR/memories/global"
BOOT_T0=$SECONDS
env DSH_HOME="$HOMEDIR" "$DSH" --profile smoke >"$LOGS/boot.log" 2>&1 &
BOOT_PID=$!
disown "$BOOT_PID" 2>/dev/null || true   # we reap it by signal; keep job control quiet
BOOT_READY=""
for _ in $(seq 1 300); do          # up to ~30s for plugin apply
  if [ -d "$APPLIED" ]; then BOOT_READY=1; break; fi
  kill -0 "$BOOT_PID" 2>/dev/null || break   # host died before the mark appeared
  sleep 0.1
done
kill -TERM "$BOOT_PID" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.1; done
kill -KILL "$BOOT_PID" 2>/dev/null || true
if [ -z "$BOOT_READY" ]; then
  echo "$HOST_TAG: smoke boot never ran the plugin's apply() ($APPLIED missing)" >&2
  exit 1
fi
echo "$HOST_TAG: step boot ok ($((SECONDS - BOOT_T0))s)"

# Static checks on the installed build: every file parses, and no relative import
# still ends in .ts (rewriteRelativeImportExtensions turns them into .js; one that
# slipped through would fail at load time, since Node won't strip types under
# node_modules). grep exit 1 = no match = pass; 0 (a hit) or 2 (error) fail.
IDX="$(find "$HOMEDIR" -type f -path '*dsh-plastic-memory/lib/index.js' 2>/dev/null | head -n 1)"
[ -n "$IDX" ] || { STEP=syntax; echo "$HOST_TAG: installed lib/index.js not found under $HOMEDIR" >&2; exit 1; }
TS_IMPORT_RE="(from|import)[[:space:]]*\(?[[:space:]]*[\"']\.{1,2}/[^\"']*\.[cm]?tsx?[\"']"
no_ts_imports() {
  local rc=0
  [ -d "$1" ] || { echo "no such directory: $1"; return 1; }   # BSD grep -r exits 1 on it
  grep -rEn --include='*.js' "$TS_IMPORT_RE" "$1" || rc=$?
  [ "$rc" -eq 1 ]
}
host_run syntax node --check "$IDX"
host_run lib-imports no_ts_imports "$(dirname "$IDX")"

host_assert_isolated
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, tgz installed, dump-config layer present, smoke boot started the plugin's apply() in the real host (full load is host:contract's job), installed lib/ parses with no .ts relative imports, ~/.dsh untouched"
