// 全量行为测试:场景名与 SPEC S1–S12 一一对应。
// 运行: node --test tools/run-tests.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox } from "./sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "chatgpt-account-switcher.user.js");
const ST_COOKIE = [{ name: "__Secure-next-auth.session-token", value: "ST-JWT", domain: "chatgpt.com" }];
const validSession = {
  accessToken: "at-valid",
  account: { id: "UUID74ac", planType: "plus", structure: "personal", residencyRegion: "no_constraint" },
  user: { id: "user-Bmg", email: "u@x.com", name: "U Name" },
  statsigContext: { locale: "zh-CN", country: "JP", deviceId: "d1" },
  expires: "2027-01-26T08:57:44.300Z",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; await sleep(5); }
  throw new Error("waitFor timeout");
}
const checkoutOk = () => ({
  checkout_session_id: "cs_live_x", publishable_key: "pk_x",
  url: "https://pay.openai.com/c/pay/cs_live_x#fid",
});

// ---------- S1 / S2:畸形 session 不崩溃 ----------
test("S1 captureCurrent: session 有 user 无 account → null + toast,不写账号", async () => {
  const sb = createSandbox(SCRIPT, {
    cookies: ST_COOKIE,
    gmValues: { cas_active: "keep" },
    sessionHandler: () => ({ user: { email: "a@b.com" } }),
  });
  const r = await sb.cas.captureCurrent();
  assert.equal(r, null);
  assert.ok(sb.toastTexts().some((t) => t.includes("会话字段缺失")));
  assert.equal(sb.gmGetValue("cas_active"), "keep");
  assert.deepEqual(Object.keys(sb.cas.accounts()), []);
});

test("S2 captureCurrent: session 缺 user 等同未登录 → null + toast,不写账号", async () => {
  const sb = createSandbox(SCRIPT, {
    cookies: ST_COOKIE,
    sessionHandler: () => ({ account: { id: "x" } }),
  });
  const r = await sb.cas.captureCurrent();
  assert.equal(r, null);
  await waitFor(() => sb.toastTexts().some((t) => t.includes("当前未登录")));
  assert.deepEqual(Object.keys(sb.cas.accounts()), []);
});
// ---------- S3:正常捕获回归 ----------
test("S3 captureCurrent: 完整新结构按 email/UUID/planType 落库", async () => {
  const sb = createSandbox(SCRIPT, { cookies: ST_COOKIE, sessionHandler: () => validSession });
  const key = await sb.cas.captureCurrent();
  assert.equal(key, "u@x.com");
  const rec = sb.cas.accounts()[key];
  assert.equal(rec.accountId, "UUID74ac");
  assert.equal(rec.planType, "plus");
  assert.equal(rec.st, "ST-JWT");
});

// ---------- S4:main 畸形 session 不崩溃 ----------
test("S4 main: 加载时畸形 session 不抛异常,active 保持空", async () => {
  assert.doesNotThrow(() => createSandbox(SCRIPT, {
    sessionHandler: () => ({ user: { email: "a@b.com" } }),
  }));
  const sb = createSandbox(SCRIPT, { sessionHandler: () => ({ user: { email: "a@b.com" } }) });
  await waitFor(() => sb.gmGetValue("cas_invalid") === false); // main 终态分支落地标记
  assert.ok(!sb.gmGetValue("cas_active")); // 不写入任何账号名
  assert.ok(sb.cas);
});

// ---------- S5:不发伪造 UA ----------
test("S5 stripeInit: headers 不含 User-Agent", async () => {
  const sb = createSandbox(SCRIPT, {
    sessionHandler: () => validSession,
    checkoutHandler: () => ({ data: checkoutOk() }),
    setXhrHandler: true,
  });
  sb.setXhrHandler(() => ({
    status: 200,
    responseText: JSON.stringify({ stripe_hosted_url: "https://checkout.stripe.com/c/pay/cs_live_x#fidok" }),
  }));
  const urls = await sb.cas.generatePlusLink("PH", "PHP");
  assert.ok(urls.external.includes("pay.openai.com"));
  assert.equal(sb.xhrCalls.length, 1);
  const headerKeys = Object.keys(sb.xhrCalls[0].headers).map((k) => k.toLowerCase());
  assert.ok(!headerKeys.includes("user-agent"));
});

// ---------- S6:Stripe locale 跟随真实浏览器 ----------
test("S6 stripeInit: browser_locale/elements locale 跟随 navigator", async () => {
  const sb = createSandbox(SCRIPT, { sessionHandler: () => validSession, checkoutHandler: () => ({ data: checkoutOk() }) });
  sb.setNavigator("ja", ["ja"]);
  sb.setXhrHandler(() => ({ status: 200, responseText: JSON.stringify({ hosted_url: "https://checkout.stripe.com/c/pay/cs_live_x#fid" }) }));
  await sb.cas.generatePlusLink("JP", "JPY");
  let body = decodeURIComponent(sb.xhrCalls.at(-1).data);
  assert.ok(body.includes("browser_locale=ja"));
  assert.ok(body.includes("elements_session_client[locale]=ja"));

  sb.setNavigator("zh-CN", ["zh-CN"]);
  await sb.cas.generatePlusLink("PH", "PHP");
  body = decodeURIComponent(sb.xhrCalls.at(-1).data);
  assert.ok(body.includes("browser_locale=zh-CN"));
  assert.ok(body.includes("elements_session_client[locale]=zh"));
});

// ---------- S7:Accept-Language 跟随 navigator ----------
test("S7 postCheckout: Accept-Language 跟随 navigator.languages", async () => {
  const sb = createSandbox(SCRIPT, { checkoutHandler: () => ({ data: {} }) });
  sb.setNavigator("ja", ["ja", "en-US"]);
  await sb.cas.postCheckout({}, "tok");
  assert.equal(sb.fetchCalls.at(-1).init.headers["Accept-Language"], "ja,en-US;q=0.9");

  const sb2 = createSandbox(SCRIPT, { checkoutHandler: () => ({ data: {} }) });
  sb2.setNavigator("zh-CN", ["zh-CN"]);
  await sb2.cas.postCheckout({}, "tok");
  assert.equal(sb2.fetchCalls.at(-1).init.headers["Accept-Language"], "zh-CN");
});

// ---------- S8:checkout 超时 ----------
test("S8 postCheckout: 挂起请求按注入超时 reject", async () => {
  const sb = createSandbox(SCRIPT, { checkoutHandler: () => new Promise(() => {}) });
  const t0 = Date.now();
  await assert.rejects(() => sb.cas.postCheckout({}, "tok", 100), /超时/);
  assert.ok(Date.now() - t0 < 1000);
});

// ---------- S9:冷却跨面板持久 ----------
test("S9 runSub: 冷却在 store 持久,重开面板仍被拦", async () => {
  const sb = createSandbox(SCRIPT, {
    sessionHandler: () => validSession,
    checkoutHandler: () => ({ data: checkoutOk() }),
  });
  sb.setXhrHandler(() => ({ status: 200, responseText: JSON.stringify({ stripe_hosted_url: "https://checkout.stripe.com/c/pay/cs_live_x#fidok" }) }));
  sb.cas.panel({ sub: true });
  await waitFor(() => sb.fetchCalls.some((c) => c.url === "/backend-api/payments/checkout"));
  await sleep(20);
  // 关闭并重新打开面板,再触发一次
  sb.cas.panel({ sub: true });
  await sleep(20);
  const checkoutCount = sb.fetchCalls.filter((c) => c.url === "/backend-api/payments/checkout").length;
  assert.equal(checkoutCount, 1);
  const statusText = sb.getElementText("cas-sub-status");
  assert.ok(statusText.includes("等") && statusText.includes("秒"));
});

// ---------- S10:stripeFetch URL 必须经 URL 解析 ----------
test("S10 stripeFetch: 合法 init URL 放行,伪造 host/协议/路径穿越全部拒绝", async () => {
  const sb = createSandbox(SCRIPT);
  sb.setXhrHandler(() => ({ status: 200, responseText: "{}" }));
  const good = "https://api.stripe.com/v1/payment_pages/cs_live_x/init";
  await sb.cas.stripeFetch(good, {}, "");
  assert.equal(sb.xhrCalls.length, 1);
  const bads = [
    "https://evil.com/v1/payment_pages/cs_live_x/init",
    "https://api.stripe.com/v1/payment_pages/cs_x/../../evil/init",
    "http://api.stripe.com/v1/payment_pages/cs_live_x/init",
    "https://api.stripe.com/v2/payment_pages/cs_live_x/init",
    "https://api.stripe.com/v1/payment_pages//init",
  ];
  for (const u of bads) await assert.rejects(() => sb.cas.stripeFetch(u, {}, ""), /非法 Stripe/);
  assert.equal(sb.xhrCalls.length, 1);
});

// ---------- S11:Stripe init 失败回退直链 ----------
test("S11 buildLongLinkUrls: Stripe 400 时回退 checkout 直链,不抛错", async () => {
  const sb = createSandbox(SCRIPT, {
    sessionHandler: () => validSession,
    checkoutHandler: () => ({ data: checkoutOk() }),
  });
  sb.setXhrHandler(() => ({ status: 400, responseText: "{}" }));
  const urls = await sb.cas.generatePlusLink("PH", "PHP");
  assert.equal(urls.external, "https://pay.openai.com/c/pay/cs_live_x#fid");
});

// ---------- S12:未登录不产生半成品 ----------
test("S12 captureCurrent: 未登录 → toast,账号数不变", async () => {
  const sb = createSandbox(SCRIPT, { sessionHandler: () => null });
  const r = await sb.cas.captureCurrent();
  assert.equal(r, null);
  assert.ok(sb.toastTexts().some((t) => t.includes("当前未登录")));
  assert.deepEqual(Object.keys(sb.cas.accounts()), []);
});

// ---------- 属性测试:不引第三方,手写 fuzz ----------
test("P1 fuzz: 任意非 api.stripe.com 主机名必须拒绝", async () => {
  const sb = createSandbox(SCRIPT);
  for (let i = 0; i < 50; i++) {
    const host = Array.from({ length: 8 }, () =>
      "abcdefghijklmnopqrstuvwxyz0123456789-".charAt(Math.floor(Math.random() * 37))).join("");
    const u = `https://${host}.com/v1/payment_pages/cs_live_x/init`;
    await assert.rejects(() => sb.cas.stripeFetch(u, {}, ""), /非法 Stripe/);
  }
  assert.equal(sb.xhrCalls.length, 0);
});

test("P2 round-trip: 长链成功时 external=pay.openai.com,internal=chatgpt.com/checkout", async () => {
  const sb = createSandbox(SCRIPT, {
    sessionHandler: () => validSession,
    checkoutHandler: () => ({ data: checkoutOk() }),
  });
  sb.setXhrHandler(() => ({
    status: 200,
    responseText: JSON.stringify({ stripe_hosted_url: "https://checkout.stripe.com/c/pay/cs_live_x#fidok" }),
  }));
  for (let i = 0; i < 5; i++) {
    const urls = await sb.cas.generatePlusLink("PH", "PHP");
    assert.ok(urls.external.startsWith("https://pay.openai.com/"));
    assert.ok(urls.internal.startsWith("https://chatgpt.com/checkout/"));
  }
});
