// ==UserScript==
// @name         ChatGPT 多账号一键切换(本地 ST)
// @namespace    codex-plus
// @version      1.5.0
// @description  在 chatgpt.com 保存多个账号的 sessionToken(ST),悬浮球/菜单一键切换,支持备份导入导出。新增 Plus 订阅支付链一键生成(菲律宾 PHP 置顶,Stripe init 三步长链,可直跳 pay.openai.com 支付页)。原理:网页登录态 = HttpOnly cookie `__Secure-next-auth.session-token`,用 GM_cookie 删旧写新后刷新。需要 Tampermonkey(GM_cookie 仅 TM 支持)。导入支持任意结构 JSON:账号对象含 sessionToken / refresh_token / access_token 任一字段即可识别。
// @author       codex_plus
// @match        https://chatgpt.com/*
// @license      MIT
// @grant        GM_cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.stripe.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 安全须知:
 * - ST 是账号钥匙,明文存在 Tampermonkey 脚本存储里(仅本机本浏览器)。勿导出分享;「备份」导出的 JSON 同样含明文 ST。
 * - 在 chatgpt.com 执行“登出所有设备”会使所有已存 ST 全部失效。
 * - ST 过期(约 30 天滚动)后需在该账号登录状态下点“保存当前账号”重新捕获。
 * - 本脚本只读写你自己的会话 cookie,不外发任何数据。
 *
 * v1.1.0
 * - UI:悬浮球入口;面板深/浅色自适应(跟随系统),账号列表 + 当前高亮,两步删除确认,
 *       导入改为面板内文本框(不再用 prompt),toast 堆叠显示,Esc/遮罩点击关闭
 * - 逻辑:捕获即标记为当前账号;页面加载时按实际会话校正 active(手动换号后不再显示陈旧标记);
 *        切换/写 cookie 失败可见(toast);会话探测 5s 超时;分块序号解析加 NaN 防御
 * - 新增:备份导出/导入(导入兼容本脚本导出的备份 JSON)
 *
 * v1.2.0
 * - 导入:支持任意结构的 JSON —— 递归扫描,账号对象含 sessionToken / refresh_token /
 *       access_token 任一凭证字段即可识别(兼容本脚本备份、sub2api、CLIProxyAPI 等导出:
 *       accounts/auths 数组或映射、单账号对象、多层嵌套均可);同键自动去重合并
 * - 仅带 API/OAuth 凭证(无 ST)的账号也可导入:列表标记「缺ST」,网页切换仍需 ST,
 *       登录该账号后点「保存当前账号」即自动合并补齐
 * - 捕获/导入统一 upsert 合并,保留既有凭证字段;账号可携带 platform/refresh_token/access_token
 *
 * v1.4.0
 * - 导入后自动更新 ST:当前浏览器登录态若命中导入账号,直接用真实 cookie 覆盖导入的旧 ST
 * - 启动自愈:ST 滚动续期后页面加载时静默覆盖存量,不再误报过期
 * - 失效提醒降噪:同一账号只提醒一次,点掉横幅后本轮不再刷屏;登录态恢复后重置
 *
 * v1.5.0(合并上游 1837620622/chatgpt-specimen-toolbox 订阅链路)
 * - 新增 Plus 订阅支付链:菲律宾 PH/PHP 置顶 + 自定义 country/currency,一次只生成一条(后链使前链失效)
 * - 长链引擎照抄上游三步法:POST /backend-api/payments/checkout → POST api.stripe.com/v1/payment_pages/{cs}/init
 *   → host 重写 checkout.stripe.com → pay.openai.com;Stripe init 失败自动回退 checkout 响应直链
 * - 面板新增「订阅 Plus」视图:常用区快捷按钮 + 结果展示(复制/新标签打开/当前页直跳);行内「订阅」按钮按当前行账号的 accessToken 生成
 * - GM_xmlhttpRequest 打 Stripe(绕同源,需 @connect api.stripe.com 声明);请求体仅 plan_name/checkout_ui_mode/billing_details/cancel_url,刻意不塞 success_url/entry_point/promo_campaign/locale
 * - 借用账号已存 accessToken(无则用当前登录态);accessToken 不落盘,仅内存使用,不外发第三方
 */
(function () {
  "use strict";

  if (typeof GM_cookie === "undefined" || typeof GM_cookie.list !== "function") {
    // 必须在 Tampermonkey 下运行;测试环境由 harness 预置 GM_cookie shim
    if (!window.__CAS_TEST__) return;
  }

  // ---------- 常量 / 存储 ----------
  const COOKIE_BASE = "__Secure-next-auth.session-token";
  const CHUNK_SIZE = 3500; // NextAuth 单 cookie 上限约 4KB,超长按 .0/.1/.2 分块
  const SECURE = COOKIE_BASE.startsWith("__Secure-");

  const store = {
    get: (k, d) => (GM_getValue(k) === undefined ? d : GM_getValue(k)),
    set: (k, v) => GM_setValue(k, v),
  };
  const getAccounts = () => store.get("cas_accounts", {});
  const putAccounts = (a) => store.set("cas_accounts", a);
  const getActive = () => store.get("cas_active", null);
  const setActive = (n) => store.set("cas_active", n);

  // 统一按主键合并写入:捕获/导入共用;缺省字段保留旧值(如先导入 API 凭证、后补 ST)
  function upsertAccount(key, patch) {
    const all = getAccounts();
    const prev = all[key] || {};
    all[key] = {
      st: patch.st || prev.st || "",
      refreshToken: patch.refreshToken || prev.refreshToken || "",
      accessToken: patch.accessToken || prev.accessToken || "",
      platform: patch.platform || prev.platform || "",
      email: patch.email || prev.email || "",
      accountId: patch.accountId || prev.accountId || "",
      addedAt: prev.addedAt || patch.addedAt || new Date().toISOString(),
    };
    putAccounts(all);
    return all[key];
  }

  // ---------- 工具 ----------
  // 所有动态文案一律走 textContent,杜绝把账号名拼进 HTML(账号名来自外部 JSON)
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function deepFind(obj, key) {
    if (Array.isArray(obj)) {
      for (const v of obj) { const r = deepFind(v, key); if (r !== undefined) return r; }
      return undefined;
    }
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (k === key && typeof v === "string" && v) return v;
      }
      for (const v of Object.values(obj)) { const r = deepFind(v, key); if (r !== undefined) return r; }
    }
    return undefined;
  }

  // ---- 通用 JSON 账号提取:任意结构,账号对象含任一必需凭证字段即可识别 ----
  // 必需凭证字段 = sessionToken(网页 ST)/ refresh_token / access_token 之一
  const CONTAINER_KEYS = ["accounts", "auths", "items", "list", "data", "result", "payload"];

  function isContainer(o) {
    for (const k of CONTAINER_KEYS) if (o[k] !== undefined) return true;
    const vals = Object.values(o);
    // 全由对象/数组组成的聚合(如备份里 name → account 的映射)不是账号本身
    return vals.length > 0 && vals.every((v) => v && typeof v === "object");
  }

  function pickStr(o, keys) {
    for (const k of keys) {
      const v = deepFind(o, k);
      if (typeof v === "string" && v) return v;
    }
    return "";
  }

  // 从单个对象里抠出账号;不是账号(容器/无凭证字段)返回 null
  function accountFromAny(o, hint) {
    if (!o || typeof o !== "object" || Array.isArray(o) || isContainer(o)) return null;
    const st = pickStr(o, ["sessionToken", "session_token", "st"]); // "st" 兼容本脚本备份格式
    const refreshToken = pickStr(o, ["refresh_token", "refreshToken"]);
    const accessToken = pickStr(o, ["access_token", "accessToken"]);
    if (!st && !refreshToken && !accessToken) return null;
    const email = pickStr(o, ["email"]);
    const name = typeof o.name === "string" && o.name ? o.name : "";
    const accountId = pickStr(o, ["account_id", "accountId", "chatgpt_account_id"]);
    const type = typeof o.type === "string" && o.type ? o.type : "";
    const platform = (typeof o.platform === "string" && o.platform) ? o.platform : (type !== "oauth" ? type : "");
    return { st, refreshToken, accessToken, email, name, accountId, platform, addedAt: pickStr(o, ["addedAt"]), hint: hint || "" };
  }

  // 命中即收、不再下钻(防止把 credentials 再拆成第二个账号);未命中则按键继续找
  function collectAccounts(node, out, hint) {
    if (Array.isArray(node)) {
      for (const v of node) collectAccounts(v, out, "");
      return;
    }
    if (!node || typeof node !== "object") return;
    const acct = accountFromAny(node, hint);
    if (acct) { out.push(acct); return; }
    for (const [k, v] of Object.entries(node)) collectAccounts(v, out, k);
  }

  // ---------- 样式(注入 <style>,不依赖 GM_addStyle) ----------
  const CSS = `
#cas-panel,#cas-launch,#cas-alert,#cas-toasts{
  --cas-bg:#ffffff;--cas-fg:#0d0d0d;--cas-muted:#8e8ea0;--cas-border:#e5e5e5;
  --cas-chip:#f7f7f8;--cas-accent:#10a37f;--cas-accent-soft:rgba(16,163,127,.12);
  --cas-danger:#ef4444;--cas-shadow:0 12px 40px rgba(0,0,0,.18);
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media (prefers-color-scheme:dark){
  #cas-panel,#cas-launch,#cas-alert,#cas-toasts{
    --cas-bg:#1e1f20;--cas-fg:#ececf1;--cas-muted:#9b9ba1;--cas-border:#3a3b3e;
    --cas-chip:#2a2b2e;--cas-accent-soft:rgba(16,163,127,.22);
    --cas-danger:#f87171;--cas-shadow:0 12px 40px rgba(0,0,0,.55);
  }
}
#cas-backdrop{position:fixed;inset:0;z-index:2147483646;background:transparent}
#cas-card{position:fixed;top:64px;right:16px;z-index:2147483647;width:340px;background:var(--cas-bg);
  color:var(--cas-fg);border:1px solid var(--cas-border);border-radius:14px;box-shadow:var(--cas-shadow);overflow:hidden}
#cas-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:12px 14px;border-bottom:1px solid var(--cas-border)}
#cas-title{font-size:14px;font-weight:700}
#cas-sub{color:var(--cas-muted);font-size:12px;margin-top:2px;max-width:260px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cas-close{border:0;background:none;color:var(--cas-muted);font-size:20px;line-height:1;
  cursor:pointer;padding:2px 8px;border-radius:6px;font-family:inherit;flex:none}
#cas-close:hover{color:var(--cas-fg);background:var(--cas-chip)}
#cas-list{max-height:280px;overflow-y:auto;padding:6px}
.cas-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px}
.cas-row:hover{background:var(--cas-chip)}
.cas-row.is-active{background:var(--cas-accent-soft)}
.cas-dot{width:8px;height:8px;border-radius:50%;background:var(--cas-border);flex:none}
.cas-dot.is-on{background:var(--cas-accent)}
.cas-badge{flex:none;font-size:10px;line-height:1;padding:3px 6px;border-radius:6px;
  border:1px solid var(--cas-border);color:var(--cas-muted);background:var(--cas-chip)}
.cas-row-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cas-row.is-active .cas-row-main{color:var(--cas-accent);font-weight:600}
.cas-btn{border:1px solid var(--cas-border);border-radius:8px;background:var(--cas-bg);color:var(--cas-fg);
  padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit;flex:none}
.cas-btn:hover{background:var(--cas-chip)}
.cas-btn-primary{background:var(--cas-accent);border-color:var(--cas-accent);color:#fff}
.cas-btn-primary:hover{background:var(--cas-accent);filter:brightness(1.08)}
.cas-btn-del:hover{border-color:var(--cas-danger);color:var(--cas-danger)}
.cas-btn-del.is-armed{background:var(--cas-danger);border-color:var(--cas-danger);color:#fff}
.cas-empty{color:var(--cas-muted);padding:14px 12px;line-height:1.7}
#cas-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--cas-border)}
#cas-import-view{display:none;padding:10px 12px;border-top:1px solid var(--cas-border)}
#cas-import-view.is-open{display:block}
#cas-import-text{width:100%;box-sizing:border-box;height:96px;resize:vertical;padding:8px;
  border:1px solid var(--cas-border);border-radius:8px;background:var(--cas-chip);color:var(--cas-fg);
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
#cas-import-text:focus{outline:none;border-color:var(--cas-accent)}
#cas-import-file{display:none}
#cas-import-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
#cas-launch{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:40px;height:40px;
  border-radius:50%;border:1px solid var(--cas-border);background:var(--cas-bg);color:var(--cas-fg);
  font:600 15px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);
  opacity:.85;transition:opacity .15s,transform .15s}
#cas-launch:hover{opacity:1;transform:scale(1.06)}
#cas-alert{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;
  display:flex;align-items:center;gap:8px;background:#7f1d1d;color:#fff;padding:8px 12px;border-radius:10px;
  box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:min(560px,92vw)}
.cas-alert-text{font-size:12.5px}
.cas-alert-btn{border:0;background:none;color:#fff;cursor:pointer;font-size:12.5px;
  padding:3px 8px;border-radius:6px;font-family:inherit;flex:none}
.cas-alert-btn:hover{background:rgba(255,255,255,.15)}
.cas-alert-btn.cas-btn-primary{background:var(--cas-accent);border-color:var(--cas-accent);color:#fff}
#cas-toasts{position:fixed;right:16px;bottom:72px;z-index:2147483647;display:flex;
  flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.cas-toast{background:#202123;color:#fff;padding:9px 13px;border-radius:10px;font-size:13px;
  box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:360px;animation:cas-in .18s ease-out}
@keyframes cas-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#cas-sub-view{display:none;padding:10px 12px;border-top:1px solid var(--cas-border)}
#cas-sub-view.is-open{display:block}
#cas-sub-view .cas-sub-title{font-weight:700;font-size:13px;margin-bottom:2px}
#cas-sub-view .cas-sub-tip{color:var(--cas-muted);font-size:11.5px;line-height:1.6;margin-bottom:8px}
#cas-sub-view .cas-sub-tip b{color:var(--cas-accent)}
.cas-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.cas-preset{border:1px solid var(--cas-border);border-radius:8px;background:var(--cas-bg);color:var(--cas-fg);
  padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}
.cas-preset:hover{background:var(--cas-chip)}
.cas-preset.is-ph{border-color:var(--cas-accent);background:var(--cas-accent-soft);font-weight:700}
.cas-preset:disabled{opacity:.5;cursor:wait}
.cas-sub-custom{display:flex;gap:6px;margin-bottom:8px}
.cas-sub-custom input{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--cas-border);border-radius:8px;
  background:var(--cas-chip);color:var(--cas-fg);font:12px/1.5 inherit}
.cas-sub-custom input:focus{outline:none;border-color:var(--cas-accent)}
#cas-sub-status{font-size:12px;color:var(--cas-muted);min-height:18px;margin-bottom:6px;word-break:break-all}
#cas-sub-result{display:none;flex-direction:column;gap:6px}
#cas-sub-result.is-open{display:flex}
#cas-sub-link{font-size:11.5px;word-break:break-all;color:var(--cas-accent);max-height:54px;overflow-y:auto}
#cas-sub-actions{display:flex;gap:6px;justify-content:flex-end}
`;

  function injectStyle() {
    if (document.getElementById("cas-style")) return;
    const s = document.createElement("style");
    s.id = "cas-style";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function toast(msg, ms) {
    let host = document.getElementById("cas-toasts");
    if (!host) {
      host = el("div");
      host.id = "cas-toasts";
      document.documentElement.appendChild(host);
    }
    const t = el("div", "cas-toast", msg);
    host.appendChild(t);
    setTimeout(() => t.remove(), ms || 3000);
  }

  // ---------- 会话 / GM_cookie Promise 封装 ----------
  async function fetchSession() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch("/api/auth/session", { credentials: "same-origin", signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.user ? j : null;
    } catch (e) {
      return null;
    }
  }

  const gmList = () =>
    new Promise((res, rej) =>
      GM_cookie.list({}, (cookies, err) => (err ? rej(err) : res(cookies || []))));
  const gmSet = (details) =>
    new Promise((res, rej) =>
      GM_cookie.set(details, (err) => (err ? rej(err) : res())));
  const gmDelete = (details) =>
    new Promise((res, rej) =>
      GM_cookie.delete(details, (err) => (err ? rej(err) : res())));

  const isSessionCookie = (c) => c.name === COOKIE_BASE || c.name.startsWith(COOKIE_BASE + ".");

  function numSuffix(name) {
    const m = name.lastIndexOf(".");
    if (m < 0) return -1;
    const n = parseInt(name.slice(m + 1), 10);
    return Number.isNaN(n) ? -1 : n;
  }

  function chunkSt(st) {
    if (st.length <= CHUNK_SIZE) return [st];
    return st.match(new RegExp(".{1," + CHUNK_SIZE + "}", "g")) || [st];
  }

  // 读取当前浏览器里的实际 ST(分块按序重组);读不到返回 ""
  async function readCurrentSt() {
    const cookies = (await gmList().catch(() => [])).filter(isSessionCookie);
    // 分块(.0/.1/…)按序重组;整 cookie 与分块并存属异常残留,以分块为准
    const chunks = cookies
      .filter((c) => c.name !== COOKIE_BASE)
      .sort((a, b) => numSuffix(a.name) - numSuffix(b.name));
    return (chunks.length ? chunks : cookies).map((c) => c.value).join("");
  }
  // 登录态对上已存账号且浏览器 ST 与存量不一致时静默覆盖(导入旧快照 / ST 滚动续期自愈)
  // 返回更新的账号名;未登录/对不上/一致返回 null,不打扰用户
  async function refreshCurrentSt(candidates) {
    const sess = await fetchSession();
    if (!sess) return null;
    const st = await readCurrentSt();
    if (!st) return null;
    const email = (sess.user && sess.user.email) || "";
    const uid = (sess.user && sess.user.id) || "";
    const all = getAccounts();
    const names = (candidates && candidates.length ? candidates : Object.keys(all));
    for (const n of names) {
      const acct = all[n];
      if (!acct) continue;
      if (n === email || (uid && acct.accountId === uid) || (email && acct.email === email)) {
        const changed = acct.st !== st;
        if (changed) upsertAccount(n, { st, email: email || acct.email, accountId: uid || acct.accountId });
        setActive(n);
        store.set("cas_invalid", false);
        return changed ? n : null;
      }
    }
    return null;
  }


  // ---------- 核心:捕获 / 导入 / 切换 / 备份 ----------
  async function captureCurrent() {
    const sess = await fetchSession();
    if (!sess) { toast("当前未登录,无法捕获账号"); return null; }
    const st = await readCurrentSt();
    if (!st) { toast("未找到会话 cookie(ST)"); return null; }

    const email = (sess.user && sess.user.email) || "";
    const accountId = (sess.account && (sess.account.account_id || sess.account.id)) || (sess.user && sess.user.id) || "";
    const name = email || accountId || "acct-" + Date.now();
    upsertAccount(name, { st, email, accountId }); // 合并保留既有凭证(如先导入的 refresh_token)
    setActive(name); // 捕获的就是当前登录态,直接对齐,避免面板显示陈旧的「当前」
    toast("已保存/更新账号:" + name);
    return name;
  }

  function importAccountsJson(parsed) {
    const found = [];
    collectAccounts(parsed, found, "");
    if (!found.length) {
      toast("JSON 里找不到可导入的账号:账号对象需含 sessionToken / refresh_token / access_token 任一字段");
      return null;
    }
    let n = 0, missingSt = 0;
    const imported = [];
    for (const f of found) {
      const email = f.email ||
        (f.name && f.name.includes("@") ? f.name : "") ||
        (f.hint && f.hint.includes("@") ? f.hint : "");
      // 主键:邮箱 > 名称 > 父级 key(兼容本脚本备份的 name→账号映射)> account_id
      const key = f.email || f.name || f.hint || f.accountId || "acct-" + Date.now() + "-" + n;
      upsertAccount(key, {
        st: f.st, refreshToken: f.refreshToken, accessToken: f.accessToken,
        platform: f.platform, email, accountId: f.accountId, addedAt: f.addedAt,
      });
      imported.push(key);
      if (!f.st) missingSt++;
      n++;
    }
    // 导入后自愈:若当前浏览器登录态正好是其中之一,直接用真实 ST 覆盖导入值
    // (导入的 ST 常是旧快照/滚动过期,当前 cookie 才是权威;不阻塞导入 toast)
    refreshCurrentSt(imported);
    toast("已导入 " + n + " 个账号" +
      (missingSt ? "(其中 " + missingSt + " 个缺 ST:网页切换需 ST,登录该账号后点「保存当前账号」补齐)" : ""));
    refreshPanel();
    return n;
  }

  function importJson(text) {
    text = (text || "").trim();
    if (!text) { toast("内容为空"); return null; }

    if (/^[A-Za-z0-9_\-.]{20,}$/.test(text)) {
      const name = "acct-" + Date.now();
      upsertAccount(name, { st: text }); // 直接粘贴裸 ST
      toast("已导入账号:" + name);
      refreshPanel();
      return name;
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { toast("不是合法 JSON,也不是 ST 字符串"); return null; }
    return importAccountsJson(parsed);
  }

  /** 只做 cookie 换装,不刷新页面(测试钩子也用它) */
  async function applySwitch(name) {
    const acct = getAccounts()[name];
    if (!acct || (!acct.st && !acct.refreshToken && !acct.accessToken)) { toast("没有这个账号:" + name); return false; }
    if (!acct.st) { toast("「" + name + "」缺 ST(网页会话凭证),无法切换;请登录该账号后点「保存当前账号」补齐"); return false; }

    try {
      // 1) 删除现有会话 cookie(含历史分块,防止旧块残留导致重组损坏)
      const cookies = (await gmList().catch(() => [])).filter(isSessionCookie);
      for (const c of cookies) {
        await gmDelete({ name: c.name, domain: c.domain || location.hostname }).catch(() => {});
      }
      // 2) 写入新 ST(超长分块);写入失败必须可见,不能默默烂在半路
      const parts = chunkSt(acct.st);
      for (let i = 0; i < parts.length; i++) {
        await gmSet({
          name: parts.length === 1 ? COOKIE_BASE : COOKIE_BASE + "." + i,
          value: parts[i],
          domain: location.hostname,
          path: "/",
          secure: SECURE,
          httpOnly: true,
        });
      }
    } catch (e) {
      toast("切换失败:" + ((e && e.message) || e));
      return false;
    }
    setActive(name);
    return true;
  }

  async function switchTo(name) {
    const ok = await applySwitch(name);
    if (ok) location.reload(); // 换 cookie 后必须刷新,页面才会以新身份重建
    return ok;
  }

  function removeAccount(name) {
    const all = getAccounts();
    delete all[name];
    putAccounts(all);
    if (getActive() === name) setActive(null);
  }

  async function copyToken(name) {
    const acct = getAccounts()[name];
    if (!acct) { toast("没有这个账号:" + name); return; }
    const lines = [];
    if (acct.accessToken) lines.push("access_token: " + acct.accessToken);
    if (acct.refreshToken) lines.push("refresh_token: " + acct.refreshToken);
    if (!lines.length) { toast("该账号没有可复制的 token"); return; }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制 " + name + " 的 token(含明文凭证,注意保管)");
    } catch (e) {
      prompt("剪贴板不可用,请手动复制:", text);
    }
  }

  async function exportBackup() {
    const all = getAccounts();
    if (!Object.keys(all).length) { toast("还没有账号可备份"); return; }
    const payload = JSON.stringify(
      { app: "chatgpt-account-switcher", version: 1, exportedAt: new Date().toISOString(), accounts: all },
      null, 2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      toast("备份 JSON 已复制到剪贴板(含明文 ST,注意保管)");
    } catch (e) {
      prompt("剪贴板不可用,请手动复制备份 JSON(含明文 ST):", payload);
    }
  }
  // ---------- Plus 订阅支付链(合并自 1837620622/chatgpt-specimen-toolbox) ----------
  // 三步长链:1) POST /backend-api/payments/checkout → cs_id + publishable_key
  //          2) POST api.stripe.com/v1/payment_pages/{cs}/init → stripe_hosted_url(带权威 #fid)
  //          3) host 重写 checkout.stripe.com → pay.openai.com → 最终长链
  // 请求体只带 4 个字段,success_url/entry_point/promo_campaign/locale 一律不塞(上游黑名单)。
  // 一次只生成一条:后生成的 checkout 会使先前链接失效。
  const CHECKOUT_URL = "/backend-api/payments/checkout";
  const CANCEL_URL = "https://chatgpt.com/#pricing";
  // OpenAI 嵌在 checkout JS 里的公开 live publishable key,仅响应没带 pk 时兜底
  const DEFAULT_STRIPE_PK = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n";
  const STRIPE_API_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
  const STRIPE_INIT_BASE = "https://api.stripe.com/v1/payment_pages/";
  // 菲律宾置顶;其余为常用兜底。country 只影响支付页币种/默认支付方式,不决定试用资格(看出口 IP)
  const SUB_PRESETS = [
    { label: "🇵🇭 菲律宾 · PHP", country: "PH", currency: "PHP", ph: true },
    { label: "德国 · EUR", country: "DE", currency: "EUR" },
    { label: "法国 · EUR", country: "FR", currency: "EUR" },
    { label: "英国 · GBP", country: "GB", currency: "GBP" },
    { label: "日本 · JPY", country: "JP", currency: "JPY" },
    { label: "美国 · USD", country: "US", currency: "USD" },
  ];

  // merchant_path 推断:openai_ie → 爱尔兰主体(欧亚多数国家);其他 → 美国 LLC
  function inferMerchantPath(country) {
    const c = String(country || "").toUpperCase();
    const ie = ["DE", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "LU", "FI", "GR", "CY",
      "EE", "LV", "LT", "MT", "SK", "SI", "GB", "PH", "JP", "SG", "MY", "TH", "ID", "VN"];
    return ie.indexOf(c) >= 0 ? "openai_ie" : "openai_llc";
  }

  function fragmentFromClientSecret(clientSecret, sessionId) {
    if (!clientSecret || !sessionId) return "";
    const marker = sessionId + "_secret_";
    const idx = clientSecret.indexOf(marker);
    if (idx < 0) return "";
    const frag = clientSecret.slice(idx + marker.length);
    return frag ? "#" + frag : "";
  }

  function extractSessionIdFromAnyUrl(data) {
    if (!data) return "";
    const cands = [data.checkout_url, data.url, data.openai_checkout_url];
    for (const u of cands) {
      if (typeof u !== "string" || !u) continue;
      const m = u.match(/(cs_(?:live|test)_[A-Za-z0-9]+)/);
      if (m) return m[1];
    }
    return "";
  }

  function extractEntityFromAnyUrl(data) {
    if (!data) return "";
    const cands = [data.checkout_url, data.url, data.openai_checkout_url];
    for (const u of cands) {
      if (typeof u !== "string" || !u) continue;
      const m = u.match(/\/checkout\/([^/]+)\/cs_(?:live|test)_/);
      if (m) return m[1];
    }
    return "";
  }

  // hosted 响应 → 外部 Stripe 长链(pay.openai.com,干净环境可开)+ 内部 wrapper(chatgpt.com,需当前登录态)
  function buildBothCheckoutUrls(data, country) {
    if (!data) return { external: "", internal: "" };
    const sid = (data.checkout_session_id || "").trim() || extractSessionIdFromAnyUrl(data);
    let external = (typeof data.url === "string" && data.url) ? data.url : "";
    if (!external && sid) {
      const frag = fragmentFromClientSecret(data.client_secret, sid);
      if (frag) external = "https://pay.openai.com/c/pay/" + sid + frag;
    }
    const entity = (data.processor_entity || "").trim() || extractEntityFromAnyUrl(data) || inferMerchantPath(country);
    const internal = sid
      ? (entity ? "https://chatgpt.com/checkout/" + entity + "/" + sid : "https://chatgpt.com/checkout/" + sid)
      : "";
    return { external: external, internal: internal };
  }

  function buildStripeInitBody(pk) {
    const jsId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(16) + Math.random().toString(16).slice(2));
    const p = new URLSearchParams();
    p.set("browser_locale", "en-US");
    p.set("elements_session_client[client_betas][0]", "custom_checkout_server_updates_1");
    p.set("elements_session_client[client_betas][1]", "custom_checkout_manual_approval_1");
    p.set("elements_session_client[elements_init_source]", "custom_checkout");
    p.set("elements_session_client[referrer_host]", "chatgpt.com");
    p.set("elements_session_client[stripe_js_id]", jsId);
    p.set("elements_session_client[locale]", "en");
    p.set("elements_session_client[is_aggregation_expected]", "false");
    p.set("elements_options_client[saved_payment_method][enable_save]", "auto");
    p.set("elements_options_client[saved_payment_method][enable_redisplay]", "auto");
    p.set("key", pk);
    p.set("_stripe_version", STRIPE_API_VERSION);
    return p.toString();
  }

  // 跨域打 Stripe:优先 GM_xmlhttpRequest(无视同源,需头部 @connect api.stripe.com);
  // 无 GM 时降级 fetch(大概率 CORS 失败 → 调用方回退 checkout 直链,不致命)。
  // URL 白名单:仅允许 payment_pages init,防页面 XSS 借通道打任意域。
  function stripeFetch(url, headers, body) {
    return new Promise((resolve, reject) => {
      if (typeof url !== "string" || url.indexOf(STRIPE_INIT_BASE) !== 0 || !/\/init$/.test(url)) {
        reject(new Error("拒绝:非法 Stripe init URL"));
        return;
      }
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "POST", url: url, headers: headers, data: body, timeout: 15000,
          onload: (res) => resolve({ status: res.status, text: res.responseText }),
          onerror: () => reject(new Error("Stripe init 请求失败(网络异常)")),
          ontimeout: () => reject(new Error("Stripe init 请求超时")),
        });
        return;
      }
      fetch(url, { method: "POST", headers: headers, body: body })
        .then((r) => r.text().then((t) => ({ status: r.status, text: t })))
        .then(resolve, reject);
    });
  }

  async function stripeInit(csId, pk) {
    const url = STRIPE_INIT_BASE + encodeURIComponent(csId) + "/init";
    const headers = {
      "Authorization": "Bearer " + pk,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    };
    const res = await stripeFetch(url, headers, buildStripeInitBody(pk));
    let data = {};
    try { data = JSON.parse(res.text); } catch (e) { /* 非 JSON 则走失败分支 */ }
    if (res.status !== 200) throw new Error("Stripe init 失败 HTTP " + res.status);
    return data;
  }

  // checkout 响应 → 长链;Stripe init 失败不致命,回退旧版直链(至少不比 checkout 原生差)
  async function buildLongLinkUrls(data, country) {
    const base = buildBothCheckoutUrls(data, country);
    const sid = (data && (data.checkout_session_id || "").trim()) || extractSessionIdFromAnyUrl(data);
    if (!sid) return base;
    const pk = (data && (data.publishable_key || "").trim()) || DEFAULT_STRIPE_PK;
    try {
      const sd = await stripeInit(sid, pk);
      let hosted = sd.stripe_hosted_url || sd.hosted_url || sd.url || "";
      if (!hosted) {
        const frag = fragmentFromClientSecret(data.client_secret, sid);
        if (frag) hosted = "https://checkout.stripe.com/c/pay/" + sid + frag;
      }
      if (!hosted) return base;
      const external = hosted.indexOf("checkout.stripe.com") >= 0
        ? hosted.replace("checkout.stripe.com", "pay.openai.com") : hosted;
      return { external: external || base.external, internal: base.internal };
    } catch (e) {
      return base;
    }
  }

  async function postCheckout(body, accessToken) {
    const r = await fetch(CHECKOUT_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON 则走失败分支 */ }
    if (!r.ok) throw new Error("checkout 失败 HTTP " + r.status + ":" + text.slice(0, 300));
    return data;
  }

  // 取 accessToken(仅内存,不落盘):指定账号有存货先用它(可给非当前登录账号生成);
  // 否则用当前浏览器登录态。
  async function resolveSubToken(preferName) {
    if (preferName) {
      const acct = getAccounts()[preferName];
      if (acct && acct.accessToken) return acct.accessToken;
    }
    const sess = await fetchSession();
    const t = sess && sess.accessToken;
    if (!t) throw new Error("没有拿到 accessToken:当前未登录,且所选账号未存 access_token(导入含 access_token 的 JSON 或先登录保存)");
    return t;
  }

  async function generatePlusLink(country, currency, preferName) {
    const token = await resolveSubToken(preferName);
    const data = await postCheckout({
      plan_name: "chatgptplusplan",
      checkout_ui_mode: "hosted",
      billing_details: { country: country, currency: currency },
      cancel_url: CANCEL_URL,
    }, token);
    const urls = await buildLongLinkUrls(data, country);
    if (!urls.external && !urls.internal) {
      throw new Error("响应里没有有效的链接。响应字段:" + Object.keys(data || {}).join(","));
    }
    return urls; // { external, internal }
  }

  // ---------- UI:面板 ----------
  function escClose(e) {
    if (e.key === "Escape") closePanel();
  }

  function closePanel() {
    document.removeEventListener("keydown", escClose);
    const p = document.getElementById("cas-panel");
    if (p) p.remove();
  }

  function buildRow(name, acct, isActive) {
    const row = el("div", "cas-row" + (isActive ? " is-active" : ""));
    row.appendChild(el("span", "cas-dot" + (isActive ? " is-on" : "")));

    const nameEl = el("div", "cas-row-main", name);
    nameEl.title = name +
      (acct && acct.platform ? " · " + acct.platform : "") +
      (acct && acct.addedAt ? " · 保存于 " + acct.addedAt.slice(0, 10) : "");
    row.appendChild(nameEl);

    if (acct && !acct.st) {
      const badge = el("span", "cas-badge", "缺ST"); // 仅有 API/OAuth 凭证、还没捕获网页 ST 的账号
      badge.title = "仅有 API/OAuth 凭证,网页切换需要 ST;登录该账号后点「保存当前账号」自动补齐";
      row.appendChild(badge);
    }

    // 主操作按钮:有 ST → 切换;仅 API/OAuth 凭证 → 复制 Token(网页切换本就不可用)
    if (acct && acct.st) {
      const btnSwitch = el("button", "cas-btn", "切换");
      btnSwitch.dataset.act = "switch";
      btnSwitch.dataset.name = name;
      btnSwitch.onclick = () => switchTo(name);
      row.appendChild(btnSwitch);
    } else {
      const btnCopy = el("button", "cas-btn", "复制Token");
      btnCopy.dataset.act = "copy";
      btnCopy.dataset.name = name;
      btnCopy.title = "复制 access_token / refresh_token,可直接用于 API/Codex 侧";
      btnCopy.onclick = () => copyToken(name);
      row.appendChild(btnCopy);
    }
    // 该行账号的 accessToken(有存货则用它)生成 Plus 支付链;无存货则回退当前登录态
    const btnSub = el("button", "cas-btn", "订阅");
    btnSub.dataset.act = "sub";
    btnSub.dataset.name = name;
    btnSub.title = "用该账号生成 Plus 订阅支付链(默认菲律宾 PHP,直达 pay.openai.com 长链)";
    btnSub.onclick = () => panel({ sub: true, subAccount: name });
    row.appendChild(btnSub);
    const btnDel = el("button", "cas-btn cas-btn-del", "删除");
    btnDel.dataset.act = "del";
    btnDel.dataset.name = name;
    // 两步确认:误触不丢 ST;3 秒未确认自动还原
    btnDel.onclick = () => {
      if (btnDel.dataset.armed) {
        removeAccount(name);
        toast("已删除:" + name);
        refreshPanel();
      } else {
        btnDel.dataset.armed = "1";
        btnDel.classList.add("is-armed");
        btnDel.textContent = "确认删除";
        setTimeout(() => {
          if (!btnDel.isConnected) return;
          delete btnDel.dataset.armed;
          btnDel.classList.remove("is-armed");
          btnDel.textContent = "删除";
        }, 3000);
      }
    };
    row.appendChild(btnDel);
    return row;
  }

  function panel(opts) {
    closePanel();
    const wrap = el("div");
    wrap.id = "cas-panel";
    wrap.innerHTML =
      '<div id="cas-backdrop"></div>' +
      '<div id="cas-card">' +
        '<div id="cas-head">' +
          '<div><div id="cas-title">账号切换</div><div id="cas-sub"></div></div>' +
          '<button id="cas-close" title="关闭 (Esc)">×</button>' +
        "</div>" +
        '<div id="cas-list"></div>' +
        '<div id="cas-import-view">' +
          '<textarea id="cas-import-text" placeholder="粘贴会话 JSON 或裸 sessionToken&#10;支持任意结构:账号对象含 sessionToken / refresh_token / access_token 任一字段即可&#10;兼容本脚本「备份」及 sub2api / CLIProxyAPI 等导出(可含多个账号)"></textarea>' +
          '<div id="cas-import-actions">' +
            '<button id="cas-import-file-btn" class="cas-btn">选择文件…</button>' +
            '<button id="cas-import-ok" class="cas-btn cas-btn-primary">确认导入</button>' +
            '<button id="cas-import-cancel" class="cas-btn">取消</button>' +
          "</div>" +
          '<input id="cas-import-file" type="file" accept=".json,.txt,application/json,text/plain" multiple>' +
        "</div>" +
        '<div id="cas-sub-view">' +
          '<div class="cas-sub-title">Plus 订阅支付链</div>' +
          '<div class="cas-sub-tip" id="cas-sub-tip"></div>' +
          '<div class="cas-presets" id="cas-sub-presets"></div>' +
          '<div class="cas-sub-custom">' +
            '<input id="cas-sub-country" maxlength="2" placeholder="国家 PH" title="ISO 3166-1 两位国家码">' +
            '<input id="cas-sub-currency" maxlength="3" placeholder="币种 PHP" title="ISO 4217 三位币种码">' +
            '<button id="cas-sub-custom-ok" class="cas-btn">生成</button>' +
          "</div>" +
          '<div id="cas-sub-status"></div>' +
          '<div id="cas-sub-result"><div id="cas-sub-link"></div>' +
          '<div id="cas-sub-actions">' +
            '<button id="cas-sub-copy" class="cas-btn">复制链接</button>' +
            '<button id="cas-sub-open" class="cas-btn">新标签打开</button>' +
            '<button id="cas-sub-goto" class="cas-btn cas-btn-primary">直接跳转支付</button>' +
          "</div></div>" +
        "</div>" +
        '<div id="cas-foot">' +
          '<button id="cas-capture" class="cas-btn">保存当前账号</button>' +
          '<button id="cas-import" class="cas-btn">导入</button>' +
          '<button id="cas-export" class="cas-btn">备份</button>' +
          '<button id="cas-sub" class="cas-btn cas-btn-primary">订阅 Plus</button>' +
         "</div>" +
       "</div>";
    document.documentElement.appendChild(wrap);

    const all = getAccounts();
    const active = getActive();
    wrap.querySelector("#cas-sub").textContent = active
      ? "当前:" + active
      : "未跟踪登录态(切换或捕获后显示)";
    const list = wrap.querySelector("#cas-list");
    const names = Object.keys(all).sort();
    if (!names.length) {
      list.appendChild(el("div", "cas-empty", "还没有账号:点「保存当前账号」捕获当前登录,或「导入」粘贴 JSON / ST"));
    } else {
      for (const n of names) list.appendChild(buildRow(n, all[n], n === active));
    }

    wrap.querySelector("#cas-close").onclick = closePanel;
    wrap.querySelector("#cas-backdrop").onclick = closePanel;
    wrap.querySelector("#cas-capture").onclick = () => captureCurrent().then(refreshPanel);
    wrap.querySelector("#cas-export").onclick = exportBackup;

    const importView = wrap.querySelector("#cas-import-view");
    const showImport = (show) => {
      importView.classList.toggle("is-open", show);
      if (show) wrap.querySelector("#cas-import-text").focus();
    };
    wrap.querySelector("#cas-import").onclick = () => showImport(!importView.classList.contains("is-open"));
    wrap.querySelector("#cas-import-cancel").onclick = () => showImport(false);
    const fileInput = wrap.querySelector("#cas-import-file");
    wrap.querySelector("#cas-import-file-btn").onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = ""; // 清空以便下次可重复选择同一文件
      if (!files.length) return;
      let ok = 0;
      Promise.all(files.map((f) =>
        f.text()
          .then((txt) => { const r = importJson(txt); if (r !== null && r !== undefined) ok++; })
          .catch(() => toast("读取文件失败:" + f.name)),
      )).then(() => { if (ok) showImport(false); });
    };
    wrap.querySelector("#cas-import-ok").onclick = () => {
      const r = importJson(wrap.querySelector("#cas-import-text").value);
      if (r !== null && r !== undefined) {
        wrap.querySelector("#cas-import-text").value = "";
        showImport(false);
        refreshPanel();
      }
    };
    if (opts && opts.import) showImport(true);

    // ---- 订阅视图:预设区按钮 + 自定义 country/currency + 结果三连(复制/新标签/直跳) ----
    const subView = wrap.querySelector("#cas-sub-view");
    const subTip = wrap.querySelector("#cas-sub-tip");
    const subPresets = wrap.querySelector("#cas-sub-presets");
    const subStatus = wrap.querySelector("#cas-sub-status");
    const subResult = wrap.querySelector("#cas-sub-result");
    const subLink = wrap.querySelector("#cas-sub-link");
    const subAccount = (opts && opts.subAccount) || getActive() || "";
    const subAcct = subAccount ? getAccounts()[subAccount] : null;
    const hasToken = !!(subAcct && subAcct.accessToken);
    // 文案走 textContent(账号名来自外部 JSON,不能拼 HTML)
    subTip.textContent = "目标账号:" + (subAccount || "(当前登录态)") +
      (hasToken ? "(用已存 access_token)" : "(用当前登录态)") +
      " · 一次只生成一条,新链会使旧链失效 · 菲律宾 PH/PHP 置顶";
    const setBusy = (busy) => {
      subPresets.querySelectorAll("button").forEach((b) => { b.disabled = busy; });
      wrap.querySelector("#cas-sub-custom-ok").disabled = busy;
    };
    const showResult = (url) => {
      subLink.textContent = url;
      subResult.classList.add("is-open");
      wrap.querySelector("#cas-sub-copy").onclick = () => {
        navigator.clipboard.writeText(url).then(
          () => toast("支付链已复制"),
          () => prompt("剪贴板不可用,请手动复制:", url),
        );
      };
      wrap.querySelector("#cas-sub-open").onclick = () => window.open(url, "_blank", "noopener");
      wrap.querySelector("#cas-sub-goto").onclick = () => { location.href = url; }; // 直接跳转到支付页面
    };
    const runSub = async (country, currency) => {
      country = String(country || "").trim().toUpperCase();
      currency = String(currency || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
        subStatus.textContent = "国家填 2 位字母(如 PH),币种填 3 位字母(如 PHP)";
        return;
      }
      setBusy(true);
      subResult.classList.remove("is-open");
      subStatus.textContent = "生成中:" + country + "/" + currency + " → checkout → Stripe init 长链…";
      try {
        const urls = await generatePlusLink(country, currency, subAccount);
        const url = urls.external || urls.internal;
        subStatus.textContent = "已生成(" + country + "/" + currency + ")" +
          (urls.external ? ":pay.openai.com 长链,干净环境可开" : ":chatgpt.com 内部链,需当前登录态");
        showResult(url);
      } catch (e) {
        subStatus.textContent = "生成失败:" + ((e && e.message) || e);
      } finally {
        setBusy(false);
      }
    };
    for (const p of SUB_PRESETS) {
      const b = el("button", "cas-preset" + (p.ph ? " is-ph" : ""), p.label);
      b.title = p.country + "/" + p.currency;
      b.onclick = () => runSub(p.country, p.currency);
      subPresets.appendChild(b);
    }
    wrap.querySelector("#cas-sub-custom-ok").onclick = () =>
      runSub(wrap.querySelector("#cas-sub-country").value, wrap.querySelector("#cas-sub-currency").value);
    const showSub = (show) => subView.classList.toggle("is-open", show);
    wrap.querySelector("#cas-sub").onclick = () => showSub(!subView.classList.contains("is-open"));
    // 行内「订阅」点进来:直接展开;是菲律宾偏好则一步直达生成,免二次点击
    if (opts && opts.sub) {
      showSub(true);
      if (store.get("cas_sub_ph_auto", true)) runSub("PH", "PHP");
    }

    document.addEventListener("keydown", escClose);
    return wrap;
  }

  function refreshPanel() {
    if (document.getElementById("cas-panel")) panel();
    launcher(); // 面板内的捕获/导入/删除都可能改变「当前」,悬浮球同步刷新
  }

  // ---------- UI:悬浮球 / 失效横幅 ----------
  function launcher() {
    const old = document.getElementById("cas-launch");
    if (old) old.remove();
    if (store.get("cas_hide_launcher", false)) return;
    const all = getAccounts();
    const active = getActive();
    const btn = el("button");
    btn.id = "cas-launch";
    const label = active || "";
    btn.textContent = label ? (label.trim().charAt(0).toUpperCase() || "⇄") : "⇄";
    btn.title = label ? "账号切换(当前:" + label + ")" : "账号切换";
    btn.onclick = () => (document.getElementById("cas-panel") ? closePanel() : panel());
    document.documentElement.appendChild(btn);
  }

  function invalidBanner() {
    const old = document.getElementById("cas-alert");
    if (old) old.remove();
    if (!store.get("cas_invalid", false)) return;
    const ack = () => store.set("cas_invalid_ack", getActive()); // 点掉后同账号本轮不再刷屏
    const bar = el("div");
    bar.id = "cas-alert";
    bar.appendChild(el("span", "cas-alert-text", "已保存账号的会话已失效(ST 过期或被登出)"));
    const fix = el("button", "cas-btn cas-btn-primary cas-alert-btn", "去处理");
    fix.onclick = () => { ack(); bar.remove(); panel(); };
    const dismiss = el("button", "cas-alert-btn", "×");
    dismiss.title = "本次隐藏";
    dismiss.onclick = () => { ack(); bar.remove(); };
    bar.append(fix, dismiss);
    document.documentElement.appendChild(bar);
  }

  // ---------- 启动 ----------
  async function main() {
    injectStyle();
    const sess = await fetchSession();
    const email = (sess && sess.user && sess.user.email) || "";
    if (sess) {
      // 自愈:当前登录态能对上已存账号才标记 active;手动换到未保存的账号时清空跟踪
      const all = getAccounts();
      const uid = (sess.user && sess.user.id) || "";
      let match = null;
      for (const n of Object.keys(all)) {
        if (n === email || (uid && all[n].accountId === uid) || (email && all[n].email === email)) { match = n; break; }
      }
      setActive(match);
      store.set("cas_invalid", false);
      store.set("cas_invalid_ack", null); // 登录态恢复,下次失效重新提醒
      // ST 滚动续期/导入旧快照自愈:浏览器 cookie 才是权威,直接覆盖存量,不打扰用户
      if (match) {
        const st = await readCurrentSt();
        if (st && all[match].st !== st) upsertAccount(match, { st });
      }
    } else if (getActive()) {
      store.set("cas_invalid", true); // 已存账号但 ST 失效
      // 同一失效账号只提醒一次,点掉横幅后本轮不再刷屏;状态变化后恢复提醒
      if (store.get("cas_invalid_ack") !== getActive()) {
        toast("⚠️ 当前会话已失效:ST 过期或被登出。请在目标账号登录状态下重新捕获");
      }
    } else {
      store.set("cas_invalid", false);
    }
    invalidBanner();
    launcher();
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("🔁 账号面板" + (email ? "(" + email + ")" : ""), () => panel());
      GM_registerMenuCommand("👤 保存当前登录账号", () => captureCurrent().then(refreshPanel));
      GM_registerMenuCommand("📥 导入账号(JSON / ST)", () => panel({ import: true }));
      GM_registerMenuCommand("📤 导出备份(复制 JSON)", exportBackup);
      GM_registerMenuCommand("💳 订阅 Plus(菲律宾 PHP 一键直达)", () => panel({ sub: true }));
      GM_registerMenuCommand("🫥 显示/隐藏悬浮球", () => {
        store.set("cas_hide_launcher", !store.get("cas_hide_launcher", false));
        launcher();
        toast(store.get("cas_hide_launcher", false) ? "悬浮球已隐藏(菜单可重新开启)" : "悬浮球已显示");
      });
      GM_registerMenuCommand("🇵🇭 开/关行内订阅自动直连(PH/PHP)", () => {
        store.set("cas_sub_ph_auto", !store.get("cas_sub_ph_auto", true));
        toast(store.get("cas_sub_ph_auto", true) ? "行内「订阅」点开即自动生成 PH/PHP" : "行内「订阅」点开后手动选区");
      });
    }
  }
  main();

  // ---------- 测试钩子(仅 __CAS_TEST__ 时暴露) ----------
  if (window.__CAS_TEST__) {
    window.__CAS__ = {
      importJson, applySwitch, switchTo, captureCurrent, removeAccount, exportBackup, copyToken, buildRow,
      refreshCurrentSt, readCurrentSt,
      generatePlusLink, buildBothCheckoutUrls, buildLongLinkUrls, inferMerchantPath,
      fragmentFromClientSecret, extractSessionIdFromAnyUrl, SUB_PRESETS,
      accounts: getAccounts, active: getActive, session: fetchSession, panel,
    };
  }
})();
