#!/usr/bin/env bash
# Package whitelist: the npm tarball carries only the built plugin and its
# published assets, never sources, tests or private trees. Run after
# `pnpm build`. Exits 1 on an unexpected or missing file.
set -euo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
pnpm pack --dry-run >"$log" 2>&1 || { cat "$log"; exit 1; }
cat "$log"
if grep -E '^\s*(src|tests|client|docs|e2e)/' "$log"; then echo 'unexpected files in the package'; exit 1; fi
for f in lib/index.js lib/client.js locale/en.json locale/zh.json assets/icon.svg assets/banner.jpg assets/architecture.svg assets/architecture.en.svg cordis.patch.yml README.md README.en.md; do
  grep -Eq "^\s*$f\s*$" "$log" || { echo "missing from the package: $f"; exit 1; }
done
