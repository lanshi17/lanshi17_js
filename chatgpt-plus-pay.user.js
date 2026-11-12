// ==UserScript==
// @name         ChatGPT Plus 一键充值
// @namespace    codex-plus
// @version      1.0.1
// @description  粘贴 Session JSON,一键生成 Plus 订阅支付链(菲律宾 PHP 置顶)。不切换账号、不读写 cookie,只用 accessToken 调 checkout 接口。accessToken 被服务端吊销时给出可操作提示。
// @author       codex_plus
// @match        https://chatgpt.com/*
// @license      MIT
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.stripe.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ── 常量 ──────────────────────────────────────────────────────────────────
  const CHECKOUT_URL = "/backend-api/payments/checkout";
  const CANCEL_URL   = "https://chatgpt.com/#pricing";
  const DEFAULT_PK   = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n";
  const STRIPE_API_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
  const STRIPE_INIT_BASE   = "https://api.stripe.com/v1/payment_pages/";
  const COOLDOWN_MS = 15000; // 防 OpenAI 风控连点

  const PRESETS = [
    { label: "🇵🇭 菲律宾 · PHP", country: "PH", currency: "PHP" },
    { label: "🇩🇪 德国 · EUR",   country: "DE", currency: "EUR" },
    { label: "🇫🇷 法国 · EUR",   country: "FR", currency: "EUR" },
    { label: "🇬🇧 英国 · GBP",   country: "GB", currency: "GBP" },
    { label: "🇯🇵 日本 · JPY",   country: "JP", currency: "JPY" },
    { label: "🇺🇸 美国 · USD",   country: "US", currency: "USD" },
  ];

  // ── 存储(仅存 accessToken,不存其他凭证) ─────────────────────────────────
  const store = {
    get: (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch (e) {} },
  };

  // ── 从 JSON 文本中提取 accessToken ────────────────────────────────────────
  function extractToken(text) {
    text = (text || "").trim();
    if (!text) return null;
    // 裸 JWT(三段 base64 点分)
    if (/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(text)) return text;
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) {
      // 截取首个 { ... } 再试
      const i = text.indexOf("{"), j = text.lastIndexOf("}");
      if (i >= 0 && j > i) { try { obj = JSON.parse(text.slice(i, j + 1)); } catch (e2) {} }
    }
    if (!obj) return null;
    // 递归搜索 accessToken / access_token 字段
    function find(o, depth) {
      if (!o || typeof o !== "object" || depth > 6) return null;
      const keys = ["accessToken", "access_token"];
      for (const k of keys) {
        if (typeof o[k] === "string" && o[k].length > 20) return o[k];
      }
      for (const v of Object.values(o)) {
        const r = find(v, depth + 1);
        if (r) return r;
      }
      return null;
    }
    return find(obj, 0);
  }

  // ── Stripe 相关 ───────────────────────────────────────────────────────────
  function inferMerchantPath(country) {
    const ie = ["DE","FR","IT","ES","NL","BE","AT","PT","IE","LU","FI","GR","CY",
                 "EE","LV","LT","MT","SK","SI","GB","PH","JP","SG","MY","TH","ID","VN"];
    return ie.includes(String(country || "").toUpperCase()) ? "openai_ie" : "openai_llc";
  }

  function fragmentFromClientSecret(clientSecret, sessionId) {
    if (!clientSecret || !sessionId) return "";
    const marker = sessionId + "_secret_";
    const idx = clientSecret.indexOf(marker);
    if (idx < 0) return "";
    const frag = clientSecret.slice(idx + marker.length);
    return frag ? "#" + frag : "";
  }

  function extractSessionId(data) {
    if (!data) return "";
    for (const u of [data.checkout_url, data.url, data.openai_checkout_url]) {
      if (typeof u !== "string" || !u) continue;
      const m = u.match(/(cs_(?:live|test)_[A-Za-z0-9]+)/);
      if (m) return m[1];
    }
    return "";
  }

  function extractEntity(data) {
    if (!data) return "";
    for (const u of [data.checkout_url, data.url, data.openai_checkout_url]) {
      if (typeof u !== "string" || !u) continue;
      const m = u.match(/\/checkout\/([^/]+)\/cs_(?:live|test)_/);
      if (m) return m[1];
    }
    return "";
  }

  function buildBothUrls(data, country) {
    if (!data) return { external: "", internal: "" };
    const sid    = (data.checkout_session_id || "").trim() || extractSessionId(data);
    let external = (typeof data.url === "string" && data.url) ? data.url : "";
    if (!external && sid) {
      const frag = fragmentFromClientSecret(data.client_secret, sid);
      if (frag) external = "https://pay.openai.com/c/pay/" + sid + frag;
    }
    const entity   = (data.processor_entity || "").trim() || extractEntity(data) || inferMerchantPath(country);
    const internal = sid
      ? (entity ? "https://chatgpt.com/checkout/" + entity + "/" + sid : "https://chatgpt.com/checkout/" + sid)
      : "";
    return { external, internal };
  }

  function buildStripeBody(pk) {
    const jsId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now().toString(16) + Math.random().toString(16).slice(2));
    const full = navigator.language || "en-US";
    const lang = full.split("-")[0];
    const p = new URLSearchParams();
    p.set("browser_locale", full);
    p.set("elements_session_client[client_betas][0]", "custom_checkout_server_updates_1");
    p.set("elements_session_client[client_betas][1]", "custom_checkout_manual_approval_1");
    p.set("elements_session_client[elements_init_source]", "custom_checkout");
    p.set("elements_session_client[referrer_host]", "chatgpt.com");
    p.set("elements_session_client[stripe_js_id]", jsId);
    p.set("elements_session_client[locale]", lang);
    p.set("elements_session_client[is_aggregation_expected]", "false");
    p.set("elements_options_client[saved_payment_method][enable_save]", "auto");
    p.set("elements_options_client[saved_payment_method][enable_redisplay]", "auto");
    p.set("key", pk);
    p.set("_stripe_version", STRIPE_API_VERSION);
    return p.toString();
  }

  function assertStripeUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error("非法 Stripe URL"); }
    if (u.protocol !== "https:" || u.hostname !== "api.stripe.com" || u.search || u.hash) throw new Error("非法 Stripe URL");
    if (!/^\/v1\/payment_pages\/(cs_(?:live|test)_[A-Za-z0-9]+)\/init$/.test(u.pathname)) throw new Error("非法 Stripe URL");
  }

  function stripeFetch(url, headers, body) {
    return new Promise((resolve, reject) => {
      try { assertStripeUrl(url); } catch (e) { reject(e); return; }
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "POST", url, headers, data: body, timeout: 15000,
          onload:    (res) => resolve({ status: res.status, text: res.responseText }),
          onerror:   ()    => reject(new Error("Stripe 请求失败(网络)")),
          ontimeout: ()    => reject(new Error("Stripe 请求超时")),
        });
        return;
      }
      fetch(url, { method: "POST", headers, body })
        .then((r) => r.text().then((t) => ({ status: r.status, text: t })))
        .then(resolve, reject);
    });
  }

  async function stripeInit(csId, pk) {
    const url = STRIPE_INIT_BASE + encodeURIComponent(csId) + "/init";
    const res = await stripeFetch(url, {
      "Authorization": "Bearer " + pk,
      "Content-Type": "application/x-www-form-urlencoded",
    }, buildStripeBody(pk));
    let data = {};
    try { data = JSON.parse(res.text); } catch (e) {}
    if (res.status !== 200) throw new Error("Stripe init HTTP " + res.status);
    return data;
  }

  async function buildLongUrl(data, country) {
    const base = buildBothUrls(data, country);
    const sid  = (data && (data.checkout_session_id || "").trim()) || extractSessionId(data);
    if (!sid) return base;
    const pk = (data && (data.publishable_key || "").trim()) || DEFAULT_PK;
    try {
      const sd  = await stripeInit(sid, pk);
      let hosted = sd.stripe_hosted_url || sd.hosted_url || sd.url || "";
      if (!hosted) {
        const frag = fragmentFromClientSecret(data.client_secret, sid);
        if (frag) hosted = "https://checkout.stripe.com/c/pay/" + sid + frag;
      }
      if (!hosted) return base;
      const external = hosted.includes("checkout.stripe.com")
        ? hosted.replace("checkout.stripe.com", "pay.openai.com") : hosted;
      return { external: external || base.external, internal: base.internal };
    } catch (e) {
      return base;
    }
  }

  function buildAcceptLanguage() {
    const ls = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || "en-US"];
    return ls.map((l, i) => i === 0 ? l : l + ";q=" + (1 - i * 0.1).toFixed(1)).join(",");
  }

  async function postCheckout(accessToken, country, currency) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(CHECKOUT_URL, {
        method: "POST",
        headers: {
          "Authorization":  "Bearer " + accessToken,
          "Content-Type":   "application/json",
          "Accept-Language": buildAcceptLanguage(),
        },
        body: JSON.stringify({
          plan_name:         "chatgptplusplan",
          checkout_ui_mode:  "hosted",
          billing_details:   { country, currency },
          cancel_url:        CANCEL_URL,
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      if (!r.ok) throw new Error("HTTP " + r.status + ": " + text.slice(0, 300));
      let data = {};
      try { data = JSON.parse(text); } catch (e) {}
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new Error("请求超时(30s)");
      throw e;
    }
  }

  async function generateLink(accessToken, country, currency) {
    const data = await postCheckout(accessToken, country, currency);
    const urls = await buildLongUrl(data, country);
    if (!urls.external && !urls.internal) throw new Error("响应中没有有效链接,字段:" + Object.keys(data || {}).join(","));
    return urls;
  }

  // ── 错误信息本地化 ────────────────────────────────────────────────────────
  function friendlyError(e) {
    const msg = (e && e.message) || String(e);
    if (/unusual activity/i.test(msg))
      return "OpenAI 风控拦截:① 别连点,新链会使旧链失效;② 出口 IP 尽量与所选国家匹配(PH 链走 PH 节点);③ 换个区或等 10–30 分钟再试。原始:" + msg;
    if (/401|unauthorized/i.test(msg))
      return "accessToken 已失效:不是 JWT 过期(那要 10 天),而是服务端吊销了它——源账号那边刷新/登录/NextAuth 滚动续期都会使旧 token 即时作废。请重新粘贴最新 Session JSON,拿到后立刻用。";
    if (/403|forbidden/i.test(msg))
      return "账号权限不足或被风控,换账号/IP 再试。";
    return "生成失败:" + msg;
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  const CSS = `
#cpay-btn{position:fixed;bottom:80px;right:16px;z-index:2147483646;
  width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;
  background:#10a37f;color:#fff;font-size:22px;line-height:48px;text-align:center;
  box-shadow:0 2px 8px rgba(0,0,0,.35);transition:opacity .15s}
#cpay-btn:hover{opacity:.85}
#cpay-panel{position:fixed;bottom:140px;right:16px;z-index:2147483647;
  width:360px;background:#fff;border-radius:12px;
  box-shadow:0 4px 24px rgba(0,0,0,.18);font-family:system-ui,sans-serif;
  font-size:13px;overflow:hidden;display:none}
#cpay-panel.open{display:block}
@media(prefers-color-scheme:dark){
  #cpay-panel{background:#202123;color:#ececec}
  #cpay-panel input,#cpay-panel textarea{background:#2a2b32;color:#ececec;border-color:#444}
  #cpay-panel button.preset{background:#2a2b32;color:#ececec;border-color:#555}
  #cpay-panel button.preset:hover{background:#3a3b42}
}
#cpay-panel h3{margin:0;padding:12px 14px;font-size:14px;font-weight:700;
  border-bottom:1px solid rgba(128,128,128,.2)}
#cpay-body{padding:12px 14px;display:flex;flex-direction:column;gap:10px}
#cpay-panel textarea{width:100%;box-sizing:border-box;height:80px;resize:vertical;
  padding:7px 9px;border:1px solid #d1d5db;border-radius:7px;font-size:12px;font-family:inherit}
#cpay-panel textarea:focus{outline:none;border-color:#10a37f}
#cpay-label{font-size:11px;color:#666;margin-bottom:-4px}
#cpay-presets{display:flex;flex-wrap:wrap;gap:6px}
#cpay-panel button.preset{padding:5px 10px;border:1px solid #d1d5db;border-radius:6px;
  cursor:pointer;background:#f9fafb;font-size:12px}
#cpay-panel button.preset:hover{background:#e5f7f2;border-color:#10a37f}
#cpay-panel button.preset.ph{background:#e5f7f2;border-color:#10a37f;font-weight:600}
#cpay-custom{display:flex;gap:6px;align-items:center}
#cpay-custom input{width:70px;padding:5px 7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px}
#cpay-custom input:focus{outline:none;border-color:#10a37f}
#cpay-panel button.go{padding:5px 12px;background:#10a37f;color:#fff;border:none;
  border-radius:6px;cursor:pointer;font-size:12px}
#cpay-panel button.go:disabled{opacity:.5;cursor:not-allowed}
#cpay-status{font-size:12px;color:#666;min-height:16px}
#cpay-result{display:none;flex-direction:column;gap:7px;
  padding:10px;background:rgba(16,163,127,.08);border-radius:8px}
#cpay-result.open{display:flex}
#cpay-link{font-size:11px;word-break:break-all;color:#0369a1;
  max-height:60px;overflow-y:auto;padding:4px;background:#f0f9ff;border-radius:4px}
#cpay-actions{display:flex;gap:6px;flex-wrap:wrap}
#cpay-panel button.act{padding:5px 11px;border:1px solid #d1d5db;border-radius:6px;
  cursor:pointer;font-size:12px;background:#fff}
#cpay-panel button.act:hover{background:#f0f9ff;border-color:#10a37f}
#cpay-token-row{display:flex;align-items:center;gap:6px;font-size:11px;color:#888}
#cpay-token-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cpay-panel button.clr{padding:3px 8px;font-size:11px;border:1px solid #fca5a5;
  color:#ef4444;background:none;border-radius:5px;cursor:pointer}
#cpay-panel button.clr:hover{background:#fef2f2}
`;

  function injectStyle() {
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function $(id) { return document.getElementById(id); }

  function buildUI() {
    // 悬浮按钮
    const btn = document.createElement("button");
    btn.id = "cpay-btn";
    btn.title = "ChatGPT Plus 充值";
    btn.textContent = "💳";
    document.documentElement.appendChild(btn);

    // 面板
    const panel = document.createElement("div");
    panel.id = "cpay-panel";
    panel.innerHTML = `
<h3>💳 ChatGPT Plus 充值</h3>
<div id="cpay-body">
  <div id="cpay-token-row" style="display:none">
    <span id="cpay-token-hint"></span>
    <button class="clr" id="cpay-clear">清除</button>
  </div>
  <div>
    <div id="cpay-label">粘贴 Session JSON 或裸 access_token</div>
    <textarea id="cpay-input" placeholder="把 chatgpt.com/api/auth/session 的 JSON 粘贴进来&#10;或直接粘贴 accessToken 字符串"></textarea>
  </div>
  <div id="cpay-presets">
    ${PRESETS.map((p) => `<button class="preset${p.country === "PH" ? " ph" : ""}" data-c="${p.country}" data-cu="${p.currency}">${p.label}</button>`).join("")}
  </div>
  <div id="cpay-custom">
    <input id="cpay-country"  placeholder="国家 PH" maxlength="2" style="text-transform:uppercase">
    <input id="cpay-currency" placeholder="币种 PHP" maxlength="3" style="text-transform:uppercase">
    <button class="go" id="cpay-go">生成</button>
  </div>
  <div id="cpay-status"></div>
  <div id="cpay-result">
    <div id="cpay-link"></div>
    <div id="cpay-actions">
      <button class="act" id="cpay-copy">📋 复制链接</button>
      <button class="act" id="cpay-open">🔗 新标签打开</button>
      <button class="act" id="cpay-goto">↗ 直接跳转</button>
    </div>
  </div>
</div>`;
    document.documentElement.appendChild(panel);

    // ── 状态 ──
    let currentToken = store.get("cpay_token", "") || "";
    let lastAt = store.get("cpay_last_at", 0);
    let busy = false;
    let lastUrl = "";

    function refreshTokenRow() {
      const row = $("cpay-token-row");
      const hint = $("cpay-token-hint");
      if (currentToken) {
        try {
          const payload = JSON.parse(atob(currentToken.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
          const exp = payload.exp ? new Date(payload.exp * 1000).toLocaleDateString("zh-CN") : "?";
          hint.textContent = "已存 token · 过期:" + exp;
        } catch (e) {
          hint.textContent = "已存 token";
        }
        row.style.display = "flex";
        $("cpay-input").placeholder = "token 已存,可直接选地区生成\n也可粘贴新 JSON 覆盖";
      } else {
        row.style.display = "none";
        $("cpay-input").placeholder = "把 chatgpt.com/api/auth/session 的 JSON 粘贴进来\n或直接粘贴 accessToken 字符串";
      }
    }

    function setStatus(msg, isErr) {
      const el = $("cpay-status");
      el.textContent = msg;
      el.style.color = isErr ? "#ef4444" : "#666";
    }

    async function run(country, currency) {
      // 先尝试从输入框解析新 token
      const raw = ($("cpay-input").value || "").trim();
      if (raw) {
        const t = extractToken(raw);
        if (!t) { setStatus("解析失败:不是合法 JSON,也找不到 accessToken 字段", true); return; }
        currentToken = t;
        store.set("cpay_token", t);
        $("cpay-input").value = "";
        refreshTokenRow();
      }
      if (!currentToken) { setStatus("请先粘贴 Session JSON 或 accessToken", true); return; }

      country  = String(country || "").trim().toUpperCase();
      currency = String(currency || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
        setStatus("国家填 2 位字母(如 PH),币种填 3 位字母(如 PHP)", true); return;
      }

      const wait = COOLDOWN_MS - (Date.now() - lastAt);
      if (wait > 0) { setStatus("请等 " + Math.ceil(wait / 1000) + " 秒(防风控冷却)", true); return; }

      busy = true;
      $("cpay-result").classList.remove("open");
      setStatus("生成中:" + country + "/" + currency + " → checkout → Stripe 长链…");
      document.querySelectorAll("#cpay-presets button, #cpay-go").forEach((b) => b.disabled = true);

      lastAt = Date.now();
      store.set("cpay_last_at", lastAt);
      try {
        const urls = await generateLink(currentToken, country, currency);
        lastUrl = urls.external || urls.internal;
        $("cpay-link").textContent = lastUrl;
        $("cpay-result").classList.add("open");
        setStatus((urls.external ? "✅ pay.openai.com 长链(干净浏览器可开)" : "✅ chatgpt.com 内链(需已登录)") + " · " + country + "/" + currency);
      } catch (e) {
        setStatus(friendlyError(e), true);
      } finally {
        busy = false;
        document.querySelectorAll("#cpay-presets button, #cpay-go").forEach((b) => b.disabled = false);
      }
    }

    // ── 事件绑定 ──
    btn.onclick = () => panel.classList.toggle("open");

    $("cpay-clear").onclick = () => {
      currentToken = ""; store.set("cpay_token", "");
      refreshTokenRow(); setStatus("");
    };

    $("cpay-presets").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-c]");
      if (b && !busy) run(b.dataset.c, b.dataset.cu);
    });

    $("cpay-go").onclick = () => {
      if (!busy) run($("cpay-country").value, $("cpay-currency").value);
    };

    $("cpay-copy").onclick = () => {
      navigator.clipboard.writeText(lastUrl).then(
        () => setStatus("✅ 链接已复制"),
        () => prompt("剪贴板不可用,手动复制:", lastUrl),
      );
    };
    $("cpay-open").onclick = () => window.open(lastUrl, "_blank", "noopener");
    $("cpay-goto").onclick = () => { location.href = lastUrl; };

    // 输入框大写转换
    ["cpay-country", "cpay-currency"].forEach((id) => {
      $(id).addEventListener("input", function () { this.value = this.value.toUpperCase(); });
    });

    refreshTokenRow();
  }

  injectStyle();
  buildUI();
})();
