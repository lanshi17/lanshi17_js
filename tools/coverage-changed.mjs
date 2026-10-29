// 变更行覆盖率门禁:
//   1) git diff --unified=0 <baseline> 取出 userscript 的新增行号
//   2) NODE_V8_COVERAGE 跑测试,读取 V8 原始覆盖率
//   3) 变更行与语句 range 求交:不与任何 range 相交的行 = 注释/空行(N-A 排除);
//      与 range 相交但没有任何 count>0 range 覆盖的行 = 未覆盖 → 门禁失败
// fail-closed:任何一步失败/文件缺失/解析异常 → exit 1,不输出 pass。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TARGET_REL = "chatgpt-account-switcher.user.js";
const baseline = process.argv[2];
if (!baseline) { console.error("usage: coverage-changed.mjs <git-baseline>"); process.exit(1); }

function fail(msg) { console.error("COVERAGE GATE FAILED: " + msg); process.exit(1); }

// ---- 1. 变更新增行 ----
const diff = spawnSync("git", ["diff", "--unified=0", baseline, "--", TARGET_REL], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
if (diff.status !== 0) fail("git diff 失败:" + diff.stderr);

const changed = new Set();
let newLine = 0;
for (const line of diff.stdout.split("\n")) {
  const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (h) { newLine = Number(h[1]); continue; }
  if (line.startsWith("+++")) continue;
  if (line.startsWith("+")) { changed.add(newLine); newLine++; }
  else if (line.startsWith("-")) { /* 旧侧行,新侧不前进 */ }
  else if (line.startsWith("\\")) { /* \ No newline */ }
  else { newLine++; } // context 行(--unified=0 下基本没有)
}
if (!changed.size) fail("diff 中没有新增行,门禁无意义(fail-closed)");

// ---- 2. V8 覆盖率 ----
const covDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-cov-"));
try {
  const run = spawnSync(process.execPath, ["--test", "--test-timeout=10000", path.join("tools", "run-tests.mjs")], {
    cwd: ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    encoding: "utf8",
  });
  if (run.status !== 0) fail("测试未通过,覆盖率不可信:\n" + run.stdout.slice(-2000) + run.stderr);

  const files = fs.readdirSync(covDir).filter((f) => f.startsWith("coverage-")).map((f) => path.join(covDir, f));
  if (!files.length) fail("没有 V8 覆盖率输出");

  const wanted = path.resolve(ROOT, TARGET_REL);
  let scriptCov = null;
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { fail("覆盖率文件解析失败:" + f); }
    for (const r of j.result || []) {
      if (r.url && r.url.endsWith(TARGET_REL) && fileURLToPath_safe(r.url) === wanted) { scriptCov = r; }
    }
  }
  if (!scriptCov) fail("覆盖率中找不到 " + TARGET_REL);

  const ranges = [];
  for (const fn of scriptCov.functions || []) {
    for (const rg of fn.ranges || []) ranges.push(rg);
  }
  if (!ranges.length) fail("脚本没有任何 coverage ranges");

  const source = fs.readFileSync(path.join(ROOT, TARGET_REL), "utf8");
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineExtent = (ln) => [lineStarts[ln - 1], lineStarts[ln - 1 + 1] ?? source.length];

  // ---- 3. 判定 ----
  const misses = [];
  let checked = 0;
  for (const ln of [...changed].sort((a, b) => a - b)) {
    const [ls, le] = lineExtent(ln);
    const anyRange = ranges.some((r) => r.startOffset < le && r.endOffset > ls);
    if (!anyRange) continue; // 注释/空行:不属于任何语句,N-A
    checked++;
    const covered = ranges.some((r) => r.count > 0 && r.startOffset < le && r.endOffset > ls);
    if (!covered) misses.push(ln);
  }
  if (!checked) fail("变更行里没有任何可执行行,门禁无意义(fail-closed)");
  console.log("changed lines: " + changed.size + ", executable: " + checked +
    ", non-code(skipped): " + (changed.size - checked));
  if (misses.length) {
    fail("未覆盖的变更行:" + misses.join(",") + " (总计 " + misses.length + "/" + checked + ")");
  }
  console.log("COVERAGE GATE PASS: " + checked + "/" + checked + " changed executable lines covered");
} finally {
  fs.rmSync(covDir, { recursive: true, force: true });
}

function fileURLToPath_safe(u) {
  try { return fileURLToPath(u); } catch (e) { return ""; }
}
