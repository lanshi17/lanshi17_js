#!/usr/bin/env bash
# 标识当前可复现源状态:HEAD commit + 工作树必须干净(版本控制文件无增删改)+
# userscript 文件 sha256。不干净 → 非零退出(fail-closed)。
set -euo pipefail
cd "$(dirname "$0")/.."

DIRTY="$(git status --porcelain -- chatgpt-account-switcher.user.js tools)"
if [ -n "${DIRTY}" ]; then
  echo "SOURCE STATE FAIL: uncommitted changes:" >&2
  echo "${DIRTY}" >&2
  exit 1
fi
echo "commit: $(git rev-parse HEAD)"
echo "userscript sha256: $(shasum -a 256 chatgpt-account-switcher.user.js | cut -d' ' -f1)"
echo "node: $(node --version)"
