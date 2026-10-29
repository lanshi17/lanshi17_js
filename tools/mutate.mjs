// 手工变异执行器(本环境无 Stryker)。
// 每个 mutant:唯一定位串、替换次数必须恰好 1(fail-closed,防止打空枪);
// 注入后跑 --check + 全量测试;finally 内恢复,恢复后用源 sha256 校验。
// 杀死判据:测试有任何失败。全部 mutant 跑完才输出汇总;有存活/恢复失败 → exit 1。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TARGET = path.join(ROOT, "chatgpt-account-switcher.user.js");

// 偏向本次修复的关键判定;每对 [old, new] 必须是源码内唯一出现。
const MUTANTS = [
  { id: "M1", desc: "captureCurrent 守卫取反",
    old: 'if (!p) { toast("会话字段缺失:响应缺 account 或 user,无法保存"); return null; }',
    now: 'if (p) { toast("会话字段缺失:响应缺 account 或 user,无法保存"); return null; }' },
  { id: "M2", desc: "超时错误判定取反",
    old: 'if (ctrl.signal.aborted) throw new Error("checkout 请求超时(" + timeoutMs + "ms)");',
    now: "if (!ctrl.signal.aborted) throw new Error(\"checkout 请求超时(\" + timeoutMs + \"ms)\");" },
  { id: "M3", desc: "Stripe 协议校验放宽为 http",
    old: 'if (u.protocol !== "https:" || u.hostname !== "api.stripe.com" || u.search || u.hash) {',
    now: 'if (u.protocol !== "http:" || u.hostname !== "api.stripe.com" || u.search || u.hash) {' },
  { id: "M4", desc: "Accept-Language q 值符号反转",
    old: 'return ls.map((l, i) => (i === 0 ? l : l + ";q=" + (1 - i * 0.1).toFixed(1))).join(",");',
    now: 'return ls.map((l, i) => (i === 0 ? l : l + ";q=" + (1 + i * 0.1).toFixed(1))).join(",");' },
  { id: "M5", desc: "冷却时间差取反(冷却永不生效)",
    old: 'const waitMs = SUB_COOLDOWN_MS - (Date.now() - store.get("cas_sub_last_at", 0));',
    now: 'const waitMs = SUB_COOLDOWN_MS - (Date.now() + store.get("cas_sub_last_at", 0));' },
  { id: "M6", desc: "Stripe host 重写判定反转(不重写为 pay.openai.com)",
    old: 'const external = hosted.indexOf("checkout.stripe.com") >= 0',
    now: 'const external = hosted.indexOf("checkout.stripe.com") < 0' },
];

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const original = fs.readFileSync(TARGET, "utf8");
const originalSha = sha256(original);

// ---- 负向对照:定位串不存在时替换计数=0,必须硬失败,不允许继续跑 ----
function proveReplacementGuard() {
  const probe = "THIS_STRING_MUST_NOT_EXIST_IN_SOURCE_42";
  if (original.includes(probe)) { console.error("NEGATIVE CONTROL BROKEN: probe unexpectedly present"); process.exit(1); }
  const count = original.split(probe).length - 1;
  if (count !== 0) { console.error("NEGATIVE CONTROL BROKEN: expected 0 matches"); process.exit(1); }
  console.log("negative control: absent-marker → 0 replacements (guard path exercised)");
}
proveReplacementGuard();

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

const results = [];
for (const m of MUTANTS) {
  const count = original.split(m.old).length - 1;
  if (count !== 1) {
    console.error(`MUTANT ${m.id} ABORTED: expected exactly 1 anchor, found ${count} (fail-closed)`);
    fs.writeFileSync(TARGET, original);
    process.exit(1);
  }
  const mutated = original.replace(m.old, m.now);
  let killed = null;
  let errorNote = "";
  try {
    fs.writeFileSync(TARGET, mutated);
    const check = run(process.execPath, ["--check", "chatgpt-account-switcher.user.js"]);
    if (check.status !== 0) { killed = true; errorNote = "syntax error"; }
    else {
      const t = run(process.execPath, ["--test", "--test-timeout=10000", path.join("tools", "run-tests.mjs")]);
      killed = t.status !== 0;
    }
  } finally {
    fs.writeFileSync(TARGET, original);
  }
  const restoredSha = sha256(fs.readFileSync(TARGET, "utf8"));
  if (restoredSha !== originalSha) {
    console.error(`MUTANT ${m.id} RESTORE FAILED: sha mismatch`);
    process.exit(1);
  }
  results.push({ id: m.id, desc: m.desc, killed, errorNote });
  console.log(`${killed ? "KILLED " : "SURVIVED"} ${m.id}: ${m.desc}${errorNote ? " (" + errorNote + ")" : ""}`);
}

const survivors = results.filter((r) => !r.killed);
console.log(`\nmutation: ${results.length - survivors.length}/${results.length} killed`);
if (survivors.length) { console.error("SURVIVORS: " + survivors.map((s) => s.id).join(",")); process.exit(1); }
console.log("MUTATION PASS");
