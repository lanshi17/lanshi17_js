// vm 沙箱:在隔离上下文里加载真实 userscript,GM_*/DOM/fetch/navigator 全部用可观测 shim。
// 设计原则:只 mock 边界(网络/存储/DOM API),不 mock 脚本逻辑;所有调用留痕供断言。
import vm from "node:vm";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import * as nodeUrl from "node:url";

const VOID_TAGS = new Set(["input", "br", "hr", "meta", "img", "link"]);

// ---- 极简 DOM:仅支持脚本实际用到的能力 ----
function makeElement(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    children: [],
    style: {},
    dataset: {},
    title: "",
    value: "",
    textContent: "",
    placeholder: "",
    disabled: false,
    isConnected: true,
    files: [],
  };
  node.classList = {
    add: (...cs) => {
      const ws = node.className.split(/\s+/).filter(Boolean);
      for (const c of cs.flat()) if (!ws.includes(c)) ws.push(c);
      node.className = ws.join(" ");
    },
    remove: (...cs) => {
      const bad = new Set(cs.flat());
      node.className = node.className.split(/\s+/).filter((c) => c && !bad.has(c)).join(" ");
    },
    toggle: (c, force) => {
      const has = node.classList.contains(c);
      const on = force === undefined ? !has : force;
      has !== on && (on ? node.classList.add(c) : node.classList.remove(c));
      return on;
    },
    contains: (c) => node.className.split(/\s+/).includes(c),
  };
  node.appendChild = (child) => { node.children.push(child); child.isConnected = true; return child; };
  node.append = (...cs) => cs.forEach((c) => node.appendChild(c));
  node.remove = () => { node.isConnected = false; };
  function walk(fn) {
    if (!node.isConnected) return undefined;
    if (fn(node)) return node;
    for (const c of node.children) {
      const r = c.walk && c.walk(fn);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  node.walk = walk;
  node.getElementById = (id) => walk((n) => n.nodeType === 1 && n.id === id) || null;
  node.querySelector = (sel) => {
    if (sel.startsWith("#")) return node.getElementById(sel.slice(1));
    return walk((n) => n.nodeType === 1 && n.tagName === sel.toUpperCase()) || null;
  };
  node.querySelectorAll = (sel) => {
    const out = [];
    walk((n) => { if (n.nodeType === 1 && n.tagName === sel.toUpperCase()) out.push(n); return false; });
    return out;
  };
  let _innerHTML = "";
  Object.defineProperty(node, "innerHTML", {
    get: () => _innerHTML,
    set: (markup) => {
      _innerHTML = markup;
      node.children = parseHtml(markup);
      for (const c of node.children) node.appendChild(c);
    },
  });
  return node;
}

// 解析面板那段固定形态 HTML:开/闭标签 + 属性;不要文本节点(动态文案脚本全走 textContent)。
function parseHtml(markup) {
  const root = { children: [] };
  const stack = [root];
  const tokRe = /<\/?[a-zA-Z][^>]*?\/?>/g;
  let m;
  while ((m = tokRe.exec(markup))) {
    const tok = m[0];
    if (tok.startsWith("</")) {
      const tag = tok.slice(2).replace(/[>\s]/g, "").toLowerCase();
      while (stack.length > 1) { const top = stack.pop(); if (top.tagName.toLowerCase() === tag) break; }
      continue;
    }
    const selfClose = tok.endsWith("/>");
    const head = selfClose ? tok.slice(1, -2) : tok.slice(1, -1);
    const tag = head.match(/^[a-zA-Z0-9]+/)[0].toLowerCase();
    const el = makeElement(tag);
    for (const am of head.slice(tag.length).matchAll(/([a-zA-Z_:][\w:-]*)(?:="([^"]*)")?/g)) {
      const k = am[1], v = am[2] ?? "";
      if (k === "id") el.id = v;
      else if (k === "class") el.className = v;
      else el[k] = v;
    }
    stack[stack.length - 1].children.push(el);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
  }
  return root.children;
}

// ---- 沙箱工厂 ----
export function createSandbox(scriptPath, opts = {}) {
  const code = fs.readFileSync(scriptPath, "utf8");

  const fetchCalls = [];
  const xhrCalls = [];
  const menuCommands = [];
  const promptCalls = [];
  const openedWindows = [];
  let sessionHandler = opts.sessionHandler || null;
  let checkoutHandler = opts.checkoutHandler || null;
  let xhrHandler = opts.xhrHandler || null;
  let cookies = opts.cookies ? opts.cookies.map((c) => ({ ...c })) : [];

  const htmlRoot = makeElement("html");
  const head = makeElement("head");
  htmlRoot.appendChild(head);

  const doc = {
    head,
    documentElement: htmlRoot,
    createElement: (t) => makeElement(t),
    getElementById: (id) => htmlRoot.getElementById(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const navigatorShim = {
    language: opts.navigatorLanguage || "zh-CN",
    languages: opts.navigatorLanguages || ["zh-CN"],
    clipboard: { writeText: () => Promise.resolve() },
  };
  const locationShim = { hostname: "chatgpt.com", href: "https://chatgpt.com/", reload: () => {} };

  function jsonResponse(data, status = 200) {
    const text = data === undefined ? "" : JSON.stringify(data);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(data),
    };
  }

  async function fetchShim(url, init = {}) {
    fetchCalls.push({ url, init });
    // 支持超时:真实 fetch 会响应 abort 事件
    if (init.signal) {
      if (init.signal.aborted) throw new Error("aborted");
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        doFetch().then(resolve, reject);
      });
    }
    return doFetch();

    async function doFetch() {
      if (url === "/api/auth/session") {
        const j = sessionHandler ? await sessionHandler() : null;
        return jsonResponse(j);
      }
      if (url === "/backend-api/payments/checkout") {
        if (!checkoutHandler) return new Promise(() => {});
        const r = await checkoutHandler(init);
        return jsonResponse(r.data, r.status || 200);
      }
      return new Promise(() => {}); // 未知 URL:挂起,不静默成功
    }
  }

  const ctx = {
    window: undefined,
    document: doc,
    navigator: navigatorShim,
    location: locationShim,
    fetch: fetchShim,
    crypto: webcrypto,
    AbortController,
    URLSearchParams: nodeUrl.URLSearchParams,
    setTimeout, clearTimeout,
    console,
    prompt: (...args) => { promptCalls.push(args); return null; },

    GM_getValue: (k) => gmStore.has(k) ? gmStore.get(k) : undefined,
    GM_setValue: (k, v) => { gmStore.set(k, v); },
    GM_cookie: {
      list: (_d, cb) => cb(cookies.map((c) => ({ ...c }))),
      set: (details, cb) => { cookies.push({ ...details }); cb(); },
      delete: (details, cb) => {
        cookies = cookies.filter((c) => !(c.name === details.name && c.domain === (details.domain || "chatgpt.com")));
        cb();
      },
    },
    GM_registerMenuCommand: (label, fn) => menuCommands.push({ label, fn }),
    GM_xmlhttpRequest: (details) => {
      xhrCalls.push(details);
      if (!xhrHandler) { details.onerror && details.onerror(new Error("no handler")); return; }
      Promise.resolve()
        .then(() => xhrHandler(details))
        .then((r) => details.onload({ status: r.status, responseText: r.responseText }))
        .catch((e) => details.onerror && details.onerror(e));
    },
  };
  const gmStore = new Map(Object.entries(opts.gmValues || {}));

  vm.createContext(ctx);
  ctx.window = ctx;
  ctx.window.open = (url) => { openedWindows.push(url); return null; };
  ctx.__CAS_TEST__ = true;
  vm.runInContext(code, ctx, { filename: scriptPath });

  return {
    cas: ctx.window.__CAS__,
    setSessionHandler: (fn) => { sessionHandler = fn; },
    setCheckoutHandler: (fn) => { checkoutHandler = fn; },
    setXhrHandler: (fn) => { xhrHandler = fn; },
    setNavigator: (language, languages) => {
      navigatorShim.language = language;
      navigatorShim.languages = languages || [language];
    },
    fetchCalls,
    xhrCalls,
    menuCommands,
    promptCalls,
    openedWindows,
    gmGetValue: (k) => gmStore.get(k),
    toastTexts: () => {
      const host = doc.getElementById("cas-toasts");
      return host ? host.children.map((c) => c.textContent) : [];
    },
    getElementText: (id) => {
      const el = doc.getElementById(id);
      return el ? el.textContent : null;
    },
  };
}
