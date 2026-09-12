// ==UserScript==
// @name         ChatGPT 多账号一键切换(本地 ST)
// @namespace    codex-plus
// @version      1.2.0
// @description  在 chatgpt.com 保存多个账号的 sessionToken(ST),悬浮球/菜单一键切换,支持备份导入导出。原理:网页登录态 = HttpOnly cookie `__Secure-next-auth.session-token`,用 GM_cookie 删旧写新后刷新。需要 Tampermonkey(GM_cookie 仅 TM 支持)。导入支持任意结构 JSON:账号对象含 sessionToken / refresh_token / access_token 任一字段即可识别。
// @author       codex_plus
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
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

  // ---------- 核心:捕获 / 导入 / 切换 / 备份 ----------
  async function captureCurrent() {
    const sess = await fetchSession();
    if (!sess) { toast("当前未登录,无法捕获账号"); return null; }
    const cookies = (await gmList().catch(() => [])).filter(isSessionCookie);
    // 分块(.0/.1/…)按序重组;整 cookie 与分块并存属异常残留,以分块为准
    const chunks = cookies
      .filter((c) => c.name !== COOKIE_BASE)
      .sort((a, b) => numSuffix(a.name) - numSuffix(b.name));
    const st = (chunks.length ? chunks : cookies).map((c) => c.value).join("");
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
      if (!f.st) missingSt++;
      n++;
    }
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

    // 每行固定一个「切换」按钮(含当前账号,重按即重写 cookie + 刷新)
    const btnSwitch = el("button", "cas-btn", "切换");
    btnSwitch.dataset.act = "switch";
    btnSwitch.dataset.name = name;
    btnSwitch.onclick = () => switchTo(name);
    row.appendChild(btnSwitch);

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
            '<button id="cas-import-ok" class="cas-btn cas-btn-primary">确认导入</button>' +
            '<button id="cas-import-cancel" class="cas-btn">取消</button>' +
          "</div>" +
        "</div>" +
        '<div id="cas-foot">' +
          '<button id="cas-capture" class="cas-btn">保存当前账号</button>' +
          '<button id="cas-import" class="cas-btn">导入</button>' +
          '<button id="cas-export" class="cas-btn">备份</button>' +
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
    wrap.querySelector("#cas-import-ok").onclick = () => {
      const r = importJson(wrap.querySelector("#cas-import-text").value);
      if (r !== null && r !== undefined) {
        wrap.querySelector("#cas-import-text").value = "";
        showImport(false);
        refreshPanel();
      }
    };
    if (opts && opts.import) showImport(true);

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
    const bar = el("div");
    bar.id = "cas-alert";
    bar.appendChild(el("span", "cas-alert-text", "已保存账号的会话已失效(ST 过期或被登出)"));
    const fix = el("button", "cas-btn cas-btn-primary cas-alert-btn", "去处理");
    fix.onclick = () => { bar.remove(); panel(); };
    const dismiss = el("button", "cas-alert-btn", "×");
    dismiss.title = "本次隐藏";
    dismiss.onclick = () => bar.remove();
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
        if (n === email || (uid && all[n].accountId === uid)) { match = n; break; }
      }
      setActive(match);
      store.set("cas_invalid", false);
    } else if (getActive()) {
      store.set("cas_invalid", true); // 已存账号但 ST 失效
      toast("⚠️ 当前会话已失效:ST 过期或被登出。请在目标账号登录状态下重新捕获");
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
      GM_registerMenuCommand("🫥 显示/隐藏悬浮球", () => {
        store.set("cas_hide_launcher", !store.get("cas_hide_launcher", false));
        launcher();
        toast(store.get("cas_hide_launcher", false) ? "悬浮球已隐藏(菜单可重新开启)" : "悬浮球已显示");
      });
    }
  }
  main();

  // ---------- 测试钩子(仅 __CAS_TEST__ 时暴露) ----------
  if (window.__CAS_TEST__) {
    window.__CAS__ = {
      importJson, applySwitch, switchTo, captureCurrent, removeAccount, exportBackup,
      accounts: getAccounts, active: getActive, session: fetchSession, panel,
    };
  }
})();
