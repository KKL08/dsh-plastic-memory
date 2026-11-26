#!/usr/bin/env bash
# Host contract: boot a fresh, real dsh host with the packed plugin and a
# sibling verify plugin that drives the memory_* tools through the real
# ctx.tools with synthetic sessions. The checks fall into four groups:
#   install and load  the installed package boots, registers its tools and
#                     its automatic checkup timer
#   tool contract     tool behaviour against the real host, no LLM needed
#   GUI contract      before booting, the installed package's browser half is
#                     checked key-free (scripts/host-contract/verify-client.ts):
#                     factory load, its slots against the host's declarations,
#                     locale files; after boot, /memory commands run through
#                     the host's command service and must decode with the GUI
#                     contract schema
#   semantic layer    model-backed checks; they run only when DEEPSEEK_API_KEY
#                     is set and the host can pick a default model, otherwise
#                     they are reported as SKIPPED.
# 第三趟始终运行：只用合成凭据和预加载的 HTTP 响应，验证默认模型自动体检成功落盘、认证脱敏及 550 分类。
# Model-backed checks can also run on another provider route the host ships
# (scripts/host-contract/test-model.ts): set TEST_LLM_PROVIDER, TEST_LLM_MODEL
# and TEST_LLM_API_KEY together. That route then takes precedence over
# DEEPSEEK_API_KEY, and the default model points at it.
# 第三趟独立指定官方路由，不继承替代路由或真实凭据。
# Never touches ~/.dsh.
#
#   scripts/host-contract/run.sh              run (temp dir removed on exit)
#   HOST_SMOKE_KEEP=1 ...                     keep the temp dir (logs, DSH_HOME) — with a key set,
#                                             the kept dir holds an owner-only .credentials.yaml
#   DEEPSEEK_API_KEY=... ...                  enable the real-model semantic-layer cases
#   TEST_LLM_PROVIDER=... TEST_LLM_MODEL=... TEST_LLM_API_KEY=... ...
#                                             same cases on another provider route
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
# A half-set alternate route fails here, before the slow build, instead of
# silently falling back to the official key.
STEP=model-config
node "$REPO/scripts/host-contract/test-model.ts" check | sed "s/^/$HOST_TAG: /"
echo "$HOST_TAG: pinned dsh host = @deepseek-ai/dsh@$PINNED"
echo "$HOST_TAG: temp root       = $TMP"

host_stage_and_pack
host_ensure
MARKER="$TMP/.marker"; : > "$MARKER"
# Which model the model-backed checks use: the state file tells the verify
# plugin; on the alternate route a second overlay adds that route and points
# the default model at it. The alternate route's key stays in the environment
# the host inherits; the overlay names only the variable.
MODEL_STATE="$TMP/model.json"
MODEL_PATCH="$TMP/model.cordis.patch.yml"
host_run model node "$REPO/scripts/host-contract/test-model.ts" prepare "$HOST" "$MODEL_STATE" "$MODEL_PATCH"
sed "s/^/$HOST_TAG: /" "$LOGS/model.log"
MODEL_KIND="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).kind)' "$MODEL_STATE")"
# On the alternate route the official key never reaches the host (plugin
# install included), so nothing can quietly fall back to it through the
# inherited environment; the default command line stays as it was.
HOST_ENV=(env)
MODEL_ARGS=()
if [ "$MODEL_KIND" = alternate ]; then
  HOST_ENV=(env -u DEEPSEEK_API_KEY)
  MODEL_ARGS=(--patch "$MODEL_PATCH")
fi
# host_install_plugin with the same environment as the boots below
host_run plugin-add "${HOST_ENV[@]}" DSH_HOME="$HOMEDIR" "$DSH" plugin --profile host add "$TGZ"
host_verify_client

PATCH="$TMP/verify.cordis.patch.yml"
sed "s#__VERIFY_URL__#file://$REPO/scripts/host-contract/verify-plugin.ts#" "$REPO/scripts/host-contract/verify.cordis.patch.yml" > "$PATCH"
if [ "$MODEL_KIND" = official ]; then
  # rc.2's credentials service does not fall back to the environment; give the
  # isolated home its own credentials file (never copied from the real ~/.dsh).
  ( umask 077; printf 'version: %s\nrefs:\n  DEEPSEEK_API_KEY: "%s"\nrecords: {}\n' "$CREDENTIALS_SCHEMA_VERSION" "$DEEPSEEK_API_KEY" > "$HOMEDIR/.credentials.yaml" )
  chmod 600 "$HOMEDIR/.credentials.yaml"  # the host refuses a credentials file readable beyond its owner
fi
# The shared agents root (global AGENTS.md / skills) also points into the temp
# dir, so the host and the plugin never read the real ~/.agents.
AGENTS_HOME="$TMP/agents"
RESULTS="$TMP/results.json"
HANDOFF="$TMP/handoff.json"
set +e
"${HOST_ENV[@]}" DSH_HOME="$HOMEDIR" DSH_AGENTS_HOME="$AGENTS_HOME" HOST_CONTRACT_OUT="$RESULTS" HOST_CONTRACT_HANDOFF="$HANDOFF" HOST_CONTRACT_MODEL_STATE="$MODEL_STATE" "$DSH" --profile host --patch "$PATCH" ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} >"$LOGS/boot.log" 2>&1
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
if [ ! -f "$HANDOFF" ]; then
  echo "$HOST_TAG: first boot exited ($code) without a handoff file; restart check cannot run. boot.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/boot.log" | head -n 10 >&2 || true
  exit 1
fi
STEP=restart
set +e
"${HOST_ENV[@]}" DSH_HOME="$HOMEDIR" DSH_AGENTS_HOME="$AGENTS_HOME" HOST_CONTRACT_OUT="$RESULTS2" HOST_CONTRACT_HANDOFF="$HANDOFF" HOST_CONTRACT_MODEL_STATE="$MODEL_STATE" HOST_CONTRACT_PHASE=restart "$DSH" --profile host --patch "$PATCH" ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} >"$LOGS/restart.log" 2>&1
code2=$?
set -e
if [ ! -f "$RESULTS2" ]; then
  echo "$HOST_TAG: restarted host exited ($code2) without results; restart.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/restart.log" | head -n 10 >&2 || true
  exit 1
fi
# 第三趟始终运行，官方适配器照常解析合成凭据，只有 HTTP 响应由预加载模块提供。
RESULTS3="$TMP/results-bad-key.json"
STEP=bad-key
HTTP_FIXTURE="$TMP/http-fixture.json"
HTTP_MODEL_STATE="$TMP/http-model.json"
HTTP_PATCH="$TMP/http.cordis.patch.yml"
node "$REPO/scripts/host-contract/http-fixture.ts" "$HOMEDIR" "$CREDENTIALS_SCHEMA_VERSION" "$HTTP_MODEL_STATE" "$HTTP_PATCH" "$HTTP_FIXTURE"
# file URL 可包含空格；NODE_OPTIONS 仅作用于这一趟，不传给前两趟或安装步骤。
HTTP_IMPORT="$(node -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$REPO/scripts/host-contract/http-fixture.ts")"
set +e
env -u DEEPSEEK_API_KEY -u TEST_LLM_API_KEY -u HOST_CONTRACT_HTTP_KEY \
  DSH_HOME="$HOMEDIR" DSH_AGENTS_HOME="$AGENTS_HOME" HOST_CONTRACT_OUT="$RESULTS3" \
  HOST_CONTRACT_MODEL_STATE="$HTTP_MODEL_STATE" HOST_CONTRACT_PHASE=bad-key \
  HOST_CONTRACT_HTTP_FIXTURE="$HTTP_FIXTURE" NODE_OPTIONS="--import=$HTTP_IMPORT" \
  "$DSH" --profile host --patch "$PATCH" --patch "$HTTP_PATCH" >"$LOGS/bad-key.log" 2>&1
code3=$?
set -e
if [ ! -f "$RESULTS3" ]; then
  echo "$HOST_TAG: bad-key host exited ($code3) without results; bad-key.log errors:" >&2
  grep -iE "error|fatal" "$LOGS/bad-key.log" | head -n 10 >&2 || true
  exit 1
fi
# Each results file comes from one boot; a failed case is reported against the
# boot that ran it, with that boot's log tail, not against the last boot started.
# H17 在第三趟计入通过或失败，不再算作第一趟无 key 时的跳过；H18 同趟计数。
STEP=results
FAILED_STEPS="$TMP/failed-steps"
set +e
node -e '
const fs = require("fs");
const [out, ...pairs] = process.argv.slice(1);
const runs = pairs.map(p => p.split(/=(.*)/s)).filter(([, f]) => fs.existsSync(f));
const r = runs.flatMap(([step, f]) => JSON.parse(fs.readFileSync(f, "utf8")).map(o => ({ ...o, step })));
for (const o of r) console.log(`${o.ok ? (o.skipped ? "SKIP" : "PASS") : "FAIL"}  ${o.id}  ${o.detail}`);
const fails = r.filter(o => !o.ok).length, skips = r.filter(o => o.skipped).length;
console.log(`host-contract: ${r.length - fails - skips} passed, ${skips} skipped, ${fails} failed`);
fs.writeFileSync(out, [...new Set(r.filter(o => !o.ok).map(o => o.step))].map(s => `${s}\n`).join(""));
process.exit(fails ? 1 : 0);
' "$FAILED_STEPS" "boot=$RESULTS" "restart=$RESULTS2" "bad-key=$RESULTS3"
summary=$?
set -e
if [ "$summary" -ne 0 ]; then
  [ ! -f "$FAILED_STEPS" ] || while read -r step; do
    [ -n "$step" ] || continue
    echo "$HOST_TAG: failed case(s) ran in step: $step" >&2
    echo "----- $step.log (tail) -----" >&2
    tail -n 40 "$LOGS/$step.log" >&2
  done < "$FAILED_STEPS"
  exit 1
fi
# The verify plugin exits the host with 0 only when every case passed; a host that
# wrote the results and then died on shutdown must not be reported as PASS.
if [ "$code" -ne 0 ] || [ "$code2" -ne 0 ] || [ "$code3" -ne 0 ]; then
  STEP=host-exit
  echo "$HOST_TAG: host exited (first=$code restart=$code2 bad-key=$code3) after writing results; log tails:" >&2
  tail -n 20 "$LOGS/boot.log" "$LOGS/restart.log" >&2
  [ ! -f "$LOGS/bad-key.log" ] || tail -n 20 "$LOGS/bad-key.log" >&2
  exit 1
fi
host_assert_isolated
echo "$HOST_TAG: PASS in ${SECONDS}s — host @$PINNED, ~/.dsh untouched"
