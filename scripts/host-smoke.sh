#!/usr/bin/env bash
# R0 install smoke: prove the PUBLISHED-shape package installs and loads in a
# fresh, real DeepSeek Harness (dsh) host, with no API key and no writes to the
# user's ~/.dsh. Everything runs under an isolated DSH_HOME in a temp dir.
#
# Steps: build lib -> stage the published shape -> npm pack -> pinned dsh host
# (cached per version) -> `dsh plugin --profile smoke add <tgz>` -> --dump-config
# has a `name: dsh-plastic-memory` layer -> short smoke-profile boot with a probe
# plugin -> static checks on the installed lib/ (`node --check`, no relative
# import left on .ts). The browser half (dsh.client, lib/client.js factory load,
# locale/*.json) is checked right after install by host_verify_client.
#
# Two stages run back to back, each with its own tarball and DSH_HOME: `full` is the
# published shape (optionalDependencies kept, @node-rs/jieba must be installed with
# the plugin) and `no-optional` strips optionalDependencies (the package must then be
# absent). Both must load and register memory_search.
#
# Why the boot step: it is the only proof that the published package loads inside
# the real host — the plugin's apply() runs, observable as memory_search being
# registered in ctx.tools (checked by scripts/host-smoke-probe.ts, patched in after
# the plugin; the plugin's load path does no disk I/O, so no directory can serve as
# the mark). Since dsh 0.1.7 the host resolves its own packages (e.g.
# @deepseek-ai/schemastery, which the plugin imports) from an in-memory runtime
# table and no longer writes `$DSH_HOME/profiles/node_modules` fallback links, so
# plain Node outside the host cannot resolve them and no pure-Node import of lib/
# is attempted. The static checks guard the build output instead. The probe exits
# the host once it has its answer; a boot that never gets there is cut off after ~30s.
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

host_ensure
MARKER="$TMP/.marker"; : > "$MARKER"
RUN_ROOT="$TMP"

# Is @node-rs/jieba resolvable from the installed plugin (the optional dependency
# `plugin add` should have installed next to it)? Prints loaded / absent /
# no-binding (package present but its prebuilt binary does not load here).
jieba_status() {
  node -e '
    const req = require("module").createRequire(process.argv[1])
    try { req.resolve("@node-rs/jieba") } catch { console.log("absent"); process.exit(0) }
    try { console.log(typeof req("@node-rs/jieba").Jieba.withDict === "function" ? "loaded" : "no-binding") } catch { console.log("no-binding") }
  ' "$1"
}

# Static checks on the installed build (run per stage): every .js file under lib/ parses, and no
# relative import still ends in .ts (rewriteRelativeImportExtensions turns them into
# .js; one that slipped through would fail at load time, since Node won't strip
# types under node_modules). grep exit 1 = no match = pass; 0 (a hit) or 2 (error) fail.
TS_IMPORT_RE="(from|import)[[:space:]]*\(?[[:space:]]*[\"']\.{1,2}/[^\"']*\.[cm]?tsx?[\"']"
no_ts_imports() {
  local rc=0
  [ -d "$1" ] || { echo "no such directory: $1"; return 1; }   # BSD grep -r exits 1 on it
  grep -rEn --include='*.js' "$TS_IMPORT_RE" "$1" || rc=$?
  [ "$rc" -eq 1 ]
}
# One node --check per file: given several paths it checks only the first (the rest
# become script args), and find -exec ... \; would swallow a failing exit status.
check_syntax() {
  local f n=0
  while IFS= read -r -d '' f; do
    node --check "$f" || { echo "syntax error: $f"; return 1; }
    n=$((n + 1))
  done < <(find "$1" -type f -name '*.js' -print0)
  echo "checked $n files"
  [ "$n" -gt 0 ]
}

# One full pass per stage: the published shape as-is (optionalDependencies kept),
# and a variant with optionalDependencies stripped, standing in for a platform
# where the optional package is skipped. The plugin must load and register
# memory_search either way: jieba is only imported on the first CJK search.
smoke_stage() {
  local variant="$1"; shift
  HOST_TAG="host-smoke[$variant]"
  STAGE="$RUN_ROOT/$variant/stage"; HOMEDIR="$RUN_ROOT/$variant/home"; LOGS="$RUN_ROOT/$variant/logs"
  mkdir -p "$STAGE" "$HOMEDIR" "$LOGS"
  host_stage_and_pack "$@"
  host_install_plugin smoke
  host_verify_client

  STEP=optional-deps
  local pkg status
  pkg="$(find "$HOMEDIR" -type f -path '*/node_modules/dsh-plastic-memory/package.json' 2>/dev/null | head -n 1)"
  status="$(jieba_status "$pkg")"
  if [ "$variant" = full ] && [ "$status" = absent ]; then
    echo "$HOST_TAG: @node-rs/jieba was not installed with the plugin (optionalDependencies dropped?)" >&2
    return 1
  fi
  if [ "$variant" = no-optional ] && [ "$status" != absent ]; then
    echo "$HOST_TAG: @node-rs/jieba is still resolvable, the stage does not exercise the missing-package path" >&2
    return 1
  fi
  echo "$HOST_TAG: step optional-deps ok (@node-rs/jieba: $status)"

  host_run dump-config env DSH_HOME="$HOMEDIR" "$DSH" --profile smoke --dump-config
  if ! grep -Eq 'name:[[:space:]]*dsh-plastic-memory' "$LOGS/dump-config.log"; then
    STEP=dump-config
    echo "$HOST_TAG: dump-config has no 'name: dsh-plastic-memory' layer" >&2
    return 1
  fi

  # Boot the smoke profile once with the probe patched in after the plugin: the probe
  # waits for the loader, checks memory_search is registered in ctx.tools, writes the
  # verdict to PROBE_OUT and exits the host (the host logs nothing without a TTY, so
  # boot.log stays empty on success). Poll for the verdict with a ~30s cap, then stop
  # the host (TERM, then KILL as a backstop) in case it did not exit on its own. If
  # the host dies first — e.g. the plugin fails to load — host_cleanup tails boot.log.
  STEP=boot
  PATCH="$RUN_ROOT/$variant/smoke.cordis.patch.yml"
  sed "s#__PROBE_URL__#file://$REPO/scripts/host-smoke-probe.ts#" "$REPO/scripts/host-smoke-probe.cordis.patch.yml" > "$PATCH"
  PROBE_OUT="$RUN_ROOT/$variant/probe.txt"
  BOOT_T0=$SECONDS
  env DSH_HOME="$HOMEDIR" HOST_SMOKE_OUT="$PROBE_OUT" "$DSH" --profile smoke --patch "$PATCH" >"$LOGS/boot.log" 2>&1 &
  BOOT_PID=$!
  disown "$BOOT_PID" 2>/dev/null || true   # we reap it by signal; keep job control quiet
  for _ in $(seq 1 300); do          # up to ~30s for plugin apply + probe
    if [ -f "$PROBE_OUT" ]; then break; fi
    kill -0 "$BOOT_PID" 2>/dev/null || break   # host died before the verdict appeared
    sleep 0.1
  done
  kill -TERM "$BOOT_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$BOOT_PID" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$BOOT_PID" 2>/dev/null || true
  if [ "$(cat "$PROBE_OUT" 2>/dev/null)" != "ok" ]; then
    echo "$HOST_TAG: smoke boot never registered the plugin's tools (probe: $(cat "$PROBE_OUT" 2>/dev/null || echo 'no verdict'))" >&2
    return 1
  fi
  echo "$HOST_TAG: step boot ok ($((SECONDS - BOOT_T0))s)"

  IDX="$(find "$HOMEDIR" -type f -path '*dsh-plastic-memory/lib/index.js' 2>/dev/null | head -n 1)"
  [ -n "$IDX" ] || { STEP=syntax; echo "$HOST_TAG: installed lib/index.js not found under $HOMEDIR" >&2; return 1; }
  host_run syntax check_syntax "$(dirname "$IDX")"
  host_run lib-imports no_ts_imports "$(dirname "$IDX")"
}

smoke_stage full
smoke_stage no-optional --without-optional
HOST_TAG="host-smoke"

host_assert_isolated
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, tgz installed, dump-config layer present, smoke boot registered the plugin's tools in the real host (tool behavior is host:contract's job), installed lib/ parses with no .ts relative imports, client bundle loads in the factory format, ~/.dsh untouched"
