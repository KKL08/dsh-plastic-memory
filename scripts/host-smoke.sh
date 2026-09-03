#!/usr/bin/env bash
# R0 install smoke: prove the PUBLISHED-shape package installs and loads in a
# fresh, real DeepSeek Harness (dsh) host, with no API key and no writes to the
# user's ~/.dsh. Everything runs under an isolated DSH_HOME in a temp dir.
#
# Steps: build lib -> stage the published shape (rewritten package.json, main ->
# lib/index.js, files whitelist) -> npm pack -> install the pinned dsh host into a
# scratch dir -> `dsh plugin --profile smoke add <tgz>` -> `--dump-config` and
# assert a `name: dsh-plastic-memory` layer -> pure-Node import of the installed
# lib/index.js and assert it exports apply/inject/name/Config.
#
# What this deliberately does NOT exercise: no LLM call, no tool invocation, no
# session run. It is an install/load/config contract check only.
#
#   scripts/host-smoke.sh          run the smoke (temp dir removed on exit)
#   HOST_SMOKE_KEEP=1 scripts/...  keep the temp dir for debugging
#   HOST_SMOKE_CACHE=<dir>         where the pinned host install is cached between runs
#                                  (default ~/.cache/dsh-plastic-memory); the plugin
#                                  install and DSH_HOME are always fresh per run.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Pinned host version has one source of truth: the plugin's own devDependencies
# lock the @deepseek-ai/dsh-* toolchain to the version it is built against.
PINNED="$(node -e 'process.stdout.write(require(process.argv[1]).devDependencies["@deepseek-ai/dsh-tools"])' "$REPO/package.json")"
REAL_DSH="${DSH_HOME_REAL:-$HOME/.dsh}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/host-smoke.XXXXXX")"
STAGE="$TMP/stage"
HOMEDIR="$TMP/home"
LOGS="$TMP/logs"
# The host itself is cached per pinned version: resolving the full dsh dependency
# tree is the slow part (minutes), and it is identical on every run. Only the
# plugin install and DSH_HOME are fresh each time — that is what the smoke tests.
HOST="${HOST_SMOKE_CACHE:-$HOME/.cache/dsh-plastic-memory}/host-$PINNED"
mkdir -p "$STAGE" "$HOMEDIR" "$LOGS"

STEP=""
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "host-smoke: FAIL at step: ${STEP:-<setup>} (exit $code)" >&2
    if [ -n "${STEP:-}" ] && [ -f "$LOGS/$STEP.log" ]; then
      echo "----- $STEP.log (tail) -----" >&2
      tail -n 40 "$LOGS/$STEP.log" >&2
    fi
  fi
  if [ "${HOST_SMOKE_KEEP:-}" = "1" ]; then
    echo "host-smoke: kept temp dir: $TMP" >&2
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

# Run a named step, capturing its output to a per-step log. On failure the trap
# prints which step failed and that log's tail, then the script exits non-zero.
run() {
  STEP="$1"; shift
  local t0=$SECONDS
  if ! "$@" >"$LOGS/$STEP.log" 2>&1; then
    return 1
  fi
  echo "host-smoke: step $STEP ok ($((SECONDS - t0))s)"
}

SECONDS=0
echo "host-smoke: pinned dsh host = @deepseek-ai/dsh@$PINNED"
echo "host-smoke: temp root       = $TMP"

# 1. Build lib/ straight into the staging tree (mirrors publish-sync; keeps the
#    repo's own lib/ out of it).
run build "$REPO/node_modules/.bin/tsc" -p "$REPO/tsconfig.build.json" --outDir "$STAGE/lib"

# 2. Stage the published shape. The package.json rewrite mirrors scripts/
#    publish-sync.sh (kept in sync by hand; see task-3.1 report on the duplication).
cp "$REPO/cordis.patch.yml" "$STAGE/cordis.patch.yml"
cp "$REPO/README.md" "$STAGE/README.md"
run stage node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keep = ["name","version","description","author","license","keywords","repository","homepage","type","engines","main","files","dependencies","peerDependencies","dsh"];
const out = {};
for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
out.main = "lib/index.js";
out.files = ["lib", "cordis.patch.yml", "README.md"];
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$REPO/package.json" "$STAGE/package.json"

# 3. npm pack the staging tree -> tarball whose contents obey the files whitelist.
run pack sh -c 'cd "$1" && npm pack --loglevel=error' _ "$STAGE"
TGZ="$STAGE/$(ls -t "$STAGE"/*.tgz | head -n 1 | xargs basename)"
[ -f "$TGZ" ] || { STEP=pack; echo "host-smoke: no tarball produced" >&2; exit 1; }
echo "host-smoke: packed          = $(basename "$TGZ")"

# 4. Install the pinned dsh host (cached per version; see HOST above). pnpm resolves
#    the tree far faster than npm; fall back to npm when pnpm is not installed.
#    Two pnpm settings mirror what npm does for a real user: peers are
#    auto-installed (dsh-app-boot reaches its cordis-plugin-group peer that way)
#    and node_modules is hoisted (flat layout, like dsh's own installer).
DSH="$HOST/node_modules/.bin/dsh"
if [ -x "$DSH" ]; then
  echo "host-smoke: host cache hit  = $HOST"
else
  mkdir -p "$HOST"
  printf '{"name":"host-smoke-host","private":true}\n' > "$HOST/package.json"
  if command -v pnpm >/dev/null 2>&1; then
    run host-install sh -c 'cd "$1" && pnpm add --ignore-scripts --config.auto-install-peers=true --config.node-linker=hoisted "@deepseek-ai/dsh@$2"' _ "$HOST" "$PINNED"
  else
    run host-install sh -c 'cd "$1" && npm i --no-audit --no-fund --ignore-scripts "@deepseek-ai/dsh@$2"' _ "$HOST" "$PINNED"
  fi
  [ -x "$DSH" ] || { STEP=host-install; echo "host-smoke: dsh bin missing at $DSH" >&2; exit 1; }
fi

# Isolation guard: nothing under the real ~/.dsh may be written from here on.
MARKER="$TMP/.marker"; : > "$MARKER"

# 5. Install the plugin from the tarball into an isolated profile.
run plugin-add env DSH_HOME="$HOMEDIR" "$DSH" plugin --profile smoke add "$TGZ"

# 6. Dump the composed config and assert the plugin shows up as a layer.
run dump-config env DSH_HOME="$HOMEDIR" "$DSH" --profile smoke --dump-config
if ! grep -Eq 'name:[[:space:]]*dsh-plastic-memory' "$LOGS/dump-config.log"; then
  STEP=dump-config
  echo "host-smoke: dump-config has no 'name: dsh-plastic-memory' layer" >&2
  exit 1
fi

# 7. Pure-Node import of the installed lib/index.js; assert the wire exports.
IDX="$(find "$HOMEDIR" -type f -path '*dsh-plastic-memory/lib/index.js' 2>/dev/null | head -n 1)"
[ -n "$IDX" ] || { STEP=import; echo "host-smoke: installed lib/index.js not found under $HOMEDIR" >&2; exit 1; }
run import node -e '
import(process.argv[1]).then(m => {
  const need = ["apply","inject","name","Config"];
  const missing = need.filter(k => !(k in m));
  if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
}).catch(e => { console.error(e); process.exit(1); });
' "$IDX"

# 8. Isolation proof: nothing under the real ~/.dsh changed since the marker.
if [ -d "$REAL_DSH" ]; then
  TOUCHED="$(find "$REAL_DSH" -newer "$MARKER" 2>/dev/null || true)"
  if [ -n "$TOUCHED" ]; then
    STEP=isolation
    echo "host-smoke: real dsh home was written to (isolation breach):" >&2
    echo "$TOUCHED" >&2
    exit 1
  fi
fi

echo "host-smoke: PASS in ${SECONDS}s — host @$PINNED, tgz installed, dump-config layer present, lib import exports apply/inject/name/Config, ~/.dsh untouched"
