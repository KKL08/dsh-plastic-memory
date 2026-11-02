#!/usr/bin/env bash
# 公开文字措辞门：源码、测试、脚本、README/CHANGELOG/CONTRIBUTING 里不得出现跨模型名和「照抄 / 借鉴 / 参考宿主」这类署名式措辞。
# 这些文字进 GitHub 和 npm，读者是外部贡献者；实现对齐宿主时写「对齐宿主」，不写出处。
#   scripts/check-public-wording.sh            # 查 tracked 公开文件
#   scripts/check-public-wording.sh --commits <range>   # 查提交信息（pre-push 用）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

pattern='codex|gpt|照抄|借鉴|参考 ?(了 ?)?(宿主|dsh|ds-harness)'

if [ "${1:-}" = "--commits" ]; then
  range="${2:?usage: --commits <range>}"
  if git log --format='--- %h %s%n%b' "$range" | grep -inE "$pattern"; then
    echo "check-public-wording: 提交信息里有跨模型名或署名式措辞（见上），改写后再推" >&2
    exit 1
  fi
  exit 0
fi

files="$(git ls-files | grep -E '^(README[^/]*\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|src/|tests/|scripts/|client/|locale/)' | grep -v '^scripts/check-public-wording.sh$' || true)"
[ -z "$files" ] && exit 0
if echo "$files" | xargs grep -inE "$pattern"; then
  echo "check-public-wording: 公开文件里有跨模型名或署名式措辞（见上）" >&2
  exit 1
fi
