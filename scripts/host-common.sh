#!/usr/bin/env bash
# Shared steps for the real-host checks (scripts/host-smoke.sh = R0 install smoke,
# scripts/host-contract/run.sh = R1 host contract). Source this file (kept beside the scripts: a lib/ subdir is gitignored); every
# function is prefixed host_ and reads/sets the variables documented below.
#
#   REPO      repository root (set by the caller)
#   PINNED    pinned dsh host version, read from the plugin's own devDependencies
#   HOST      per-version cache dir holding the installed host (node_modules/.bin/dsh)
#   TMP       per-run scratch root (STAGE, HOMEDIR, LOGS live under it)
#
# host_run NAME CMD... runs one step, logs to $LOGS/NAME.log, prints elapsed
# seconds, and returns non-zero on failure (callers rely on set -e + a trap).

host_init() {
  PINNED="$(node -e 'process.stdout.write(require(process.argv[1]).devDependencies["@deepseek-ai/dsh-tools"])' "$REPO/package.json")"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/${1:-host-check}.XXXXXX")"
  STAGE="$TMP/stage"
  HOMEDIR="$TMP/home"
  LOGS="$TMP/logs"
  # The host itself is cached per pinned version: resolving the full dsh
  # dependency tree is the slow part and identical on every run. The plugin
  # install and DSH_HOME are fresh each run — that is what the checks test.
  HOST="${HOST_SMOKE_CACHE:-$HOME/.cache/dsh-plastic-memory}/host-$PINNED"
  DSH="$HOST/node_modules/.bin/dsh"
  mkdir -p "$STAGE" "$HOMEDIR" "$LOGS"
  STEP=""
}

host_run() {
  STEP="$1"; shift
  local t0=$SECONDS
  if ! "$@" >"$LOGS/$STEP.log" 2>&1; then
    return 1
  fi
  echo "$HOST_TAG: step $STEP ok ($((SECONDS - t0))s)"
}

# Print the failing step's log tail; remove TMP unless HOST_SMOKE_KEEP=1.
host_cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "$HOST_TAG: FAIL at step: ${STEP:-<setup>} (exit $code)" >&2
    if [ -n "${STEP:-}" ] && [ -f "$LOGS/$STEP.log" ]; then
      echo "----- $STEP.log (tail) -----" >&2
      tail -n 40 "$LOGS/$STEP.log" >&2
    fi
  fi
  if [ "${HOST_SMOKE_KEEP:-}" = "1" ]; then
    echo "$HOST_TAG: kept temp dir: $TMP" >&2
  else
    rm -rf "$TMP"
  fi
}

# Build lib/ into STAGE and write the published package shape (same rewrite as
# scripts/publish-sync.sh: runtime fields only, main -> lib/index.js, files
# whitelist), then npm pack it. Sets TGZ.
host_stage_and_pack() {
  host_run build "$REPO/node_modules/.bin/tsc" -p "$REPO/tsconfig.build.json" --outDir "$STAGE/lib"
  cp "$REPO/cordis.patch.yml" "$STAGE/cordis.patch.yml"
  cp "$REPO/README.md" "$STAGE/README.md"
  host_run stage node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keep = ["name","version","description","author","license","keywords","repository","homepage","type","engines","main","files","dependencies","peerDependencies","dsh"];
const out = {};
for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
out.main = "lib/index.js";
out.files = ["lib", "cordis.patch.yml", "README.md"];
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$REPO/package.json" "$STAGE/package.json"
  host_run pack sh -c 'cd "$1" && npm pack --loglevel=error' _ "$STAGE"
  TGZ="$STAGE/$(ls -t "$STAGE"/*.tgz | head -n 1 | xargs basename)"
  [ -f "$TGZ" ] || { STEP=pack; echo "$HOST_TAG: no tarball produced" >&2; return 1; }
  echo "$HOST_TAG: packed          = $(basename "$TGZ")"
}

# Install the pinned host into the cache if missing. Two pnpm settings mirror
# what npm does for a real user: peers are auto-installed (dsh-app-boot reaches
# its cordis-plugin-group peer that way) and node_modules is hoisted (flat
# layout, like dsh's own installer). Falls back to npm when pnpm is absent.
host_ensure() {
  if [ -x "$DSH" ]; then
    echo "$HOST_TAG: host cache hit  = $HOST"
    return 0
  fi
  mkdir -p "$HOST"
  printf '{"name":"host-smoke-host","private":true}\n' > "$HOST/package.json"
  if command -v pnpm >/dev/null 2>&1; then
    host_run host-install sh -c 'cd "$1" && pnpm add --ignore-scripts --config.auto-install-peers=true --config.node-linker=hoisted "@deepseek-ai/dsh@$2"' _ "$HOST" "$PINNED"
  else
    host_run host-install sh -c 'cd "$1" && npm i --no-audit --no-fund --ignore-scripts "@deepseek-ai/dsh@$2"' _ "$HOST" "$PINNED"
  fi
  [ -x "$DSH" ] || { STEP=host-install; echo "$HOST_TAG: dsh bin missing at $DSH" >&2; return 1; }
}

# Install the packed plugin into a fresh profile under the isolated HOMEDIR.
host_install_plugin() {
  local profile="$1"
  host_run plugin-add env DSH_HOME="$HOMEDIR" "$DSH" plugin --profile "$profile" add "$TGZ"
}

# Fail if anything under the real ~/.dsh is newer than MARKER.
host_assert_isolated() {
  local real="${DSH_HOME_REAL:-$HOME/.dsh}"
  if [ -d "$real" ]; then
    local touched
    touched="$(find "$real" -newer "$MARKER" 2>/dev/null || true)"
    if [ -n "$touched" ]; then
      STEP=isolation
      echo "$HOST_TAG: real dsh home was written to (isolation breach):" >&2
      echo "$touched" >&2
      return 1
    fi
  fi
}
