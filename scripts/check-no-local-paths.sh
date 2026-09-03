#!/usr/bin/env bash
# Leak gate: reject machine-local absolute paths and this machine's hostname in a
# tree destined to be published. lcov/html coverage reports and careless fixtures
# embed absolute paths; the public repo and npm tarball must carry none.
#
# Default target: this repo's git-tracked files (`git ls-files`). Optional first
# arg: a directory to scan instead, e.g. a staged package tree. Exits 1 on any
# hit (printing file:line:match), 0 when clean.
set -euo pipefail

target="${1:-}"

# Directories that are never published and never scanned.
excludes=(.git node_modules coverage lib e2e .agent-handoff docs)
exclude_re="$(IFS='|'; printf '%s' "${excludes[*]}")"

# Build the machine-path needle without ever writing the literal, so this script
# does not flag itself when it scans the tracked tree.
slash='/'
users_needle="${slash}Users${slash}"
home_needle="${HOME:-}"
host_needle="$(hostname)"

files=()
if [[ -n "$target" ]]; then
  [[ -d "$target" ]] || { echo "leak-gate: not a directory: $target" >&2; exit 2; }
  while IFS= read -r f; do files+=("$f"); done \
    < <(find "$target" -type f | grep -vE "/($exclude_re)/" || true)
else
  cd "$(git rev-parse --show-toplevel)"
  while IFS= read -r f; do files+=("$f"); done \
    < <(git ls-files | grep -vE "^($exclude_re)/" || true)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  echo "leak-gate: no files to scan"
  exit 0
fi

needles=("$users_needle")
[[ -n "$home_needle" ]] && needles+=("$home_needle")
[[ -n "$host_needle" ]] && needles+=("$host_needle")

hit_output=""
for n in "${needles[@]}"; do
  out="$(grep -nIHF -- "$n" "${files[@]}" 2>/dev/null || true)"
  [[ -n "$out" ]] && hit_output+="$out"$'\n'
done

if [[ -n "${hit_output//[$'\n']/}" ]]; then
  echo "leak-gate: FAIL — machine-local path or hostname found:" >&2
  printf '%s' "$hit_output" >&2
  exit 1
fi

echo "leak-gate: OK — scanned ${#files[@]} tracked file(s), no machine paths or hostname."
