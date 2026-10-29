#!/usr/bin/env bash
# Gauntlet 单一入口:语法 → 全量行为测试(含属性) → 变更行覆盖率门禁 → 变异。
# 用法: tools/gauntlet.sh [git-baseline]   (baseline = RED 提交,默认 412d59e)
# 每层显式处理退出码;任何一层失败立即退出,不继续。
set -euo pipefail

cd "$(dirname "$0")/.."
BASELINE="${1:-412d59e}"

echo "=== L1 syntax ==="
node --check chatgpt-account-switcher.user.js
echo "syntax: OK"

echo "=== L2 behavior tests (S1-S12 + properties P1/P2) ==="
node --test --test-timeout=10000 tools/run-tests.mjs

echo "=== L3 changed-line coverage gate (baseline ${BASELINE}) ==="
node tools/coverage-changed.mjs "${BASELINE}"

echo "=== L4 mutation ==="
node tools/mutate.mjs

echo "=== L5 determinism re-run (substitute for randomized order) ==="
node --test --test-timeout=10000 tools/run-tests.mjs >/dev/null
echo "second run: OK (note: cannot detect cross-file order dependence — see EVIDENCE)"

echo ""
echo "GAUNTLET PASS"
