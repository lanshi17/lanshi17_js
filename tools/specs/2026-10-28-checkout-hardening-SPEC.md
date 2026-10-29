# SPEC — checkout 链路加固(崩溃守卫 / 指纹一致性 / 超时 / 持久冷却 / URL 校验)

- Tier: 2(支付链鉴权请求,bug 修复为主;不涉及货币计算本身)
- Date: 2026-10-28
- Setup plan:
  - Tools to install: none(Node 自带 `node:test` / `node:assert` / `vm`)
  - Git: 直接在 master 工作(沿用本仓既有约定);提交节奏 = SPEC 提交 → RED 测试提交 → GREEN 修复提交 → EVIDENCE 提交
  - Files the gauntlet will add, **by path**:
    - `tools/sandbox.mjs` — vm 沙箱(GM_* / DOM / fetch / navigator shim),加载真实 userscript
    - `tools/run-tests.mjs` — 全部断言式测试(含属性测试用例)
    - `tools/mutate.mjs` — 手工变异执行器(唯一字符串替换,fail-closed)
    - `tools/gauntlet.sh` — 单一入口,重跑全部层
    - `tools/specs/2026-10-28-checkout-hardening-SPEC.md`(本文件)
    - `tools/specs/2026-10-28-checkout-hardening-EVIDENCE.md`
  - New dependencies: none(刻意零依赖;Node 版本要求 ≥ 22,覆盖率阈值用内置 `--test-coverage-*`)
  - Isolation: 不开 worktree(单人小仓,历史均直接提交 master);沙箱通过 vm 隔离,不污染全局

## Background(已确认缺陷,证据为审源码所得)

1. `captureCurrent`:`parseSession(sess)` 可返回 null(session 缺 `account`/`user`),下一行 `p.email` 直接 TypeError,无 toast。
2. `main`:`if (sess)` 内直接用 `p.email`,同样的 null 解引用。
3. `stripeInit`:硬编码假 `User-Agent`(Windows Chrome/147),与真实浏览器(TLS/HTTP2 指纹)矛盾;`buildStripeInitBody` 写死 `browser_locale=en-US` / `locale=en`。指纹矛盾是风控特征。
4. `postCheckout`:硬编码 `Accept-Language: zh-CN`,不跟随真实 `navigator.languages`。
5. 订阅冷却 `lastSubAt` 在 panel 闭包内,关面板重开即清零,15s 防连点失效。
6. `postCheckout` 无超时,服务端挂起时按钮永久 busy。
7. `stripeFetch` URL 白名单用字符串前缀 `indexOf(...)===0`,非 URL 解析;声称的「防 XSS 借通道」不完整。

## Scenarios

```gherkin
Feature: checkout 链路加固
  Scenario: S1 捕获时 session 缺 account 字段不崩溃
    Given fetch "/api/auth/session" 返回 {"user":{"email":"a@b.com"}}(无 account)
    And   GM_cookie 能读到当前 ST
    When  captureCurrent()
    Then  返回 null
    And   toast 出现,文案包含 "会话字段缺失"
    And   cas_active 不变,不产生新账号记录

  Scenario: S2 捕获时 session 缺 user 字段不崩溃(等同未登录)
    Given session 返回 {"account":{"id":"x"}}
    When  captureCurrent()
    Then  返回 null
    And   toast 含 "当前未登录"(fetchSession 以 user 存在为登录判据,缺 user 即判未登录,不进入字段缺失分支)
    And   不写入账号

  Scenario: S3 正常捕获仍按新结构落库(回归)
    Given session 返回完整新结构(email=u@x.com, account.id=UUID74ac, planType=plus)
    When  captureCurrent()
    Then  主键 = u@x.com,accountId = UUID74ac,planType = "plus"

  Scenario: S4 main 自愈在畸形 session 下不崩溃
    Given session 有 user 无 account
    When  main() 执行
    Then  不抛异常,active 保持空(终态分支不调用 setActive,不写入账号名)

  Scenario: S5 Stripe init 不再伪造 User-Agent
    Given 已通过 checkout 拿到 cs_id + pk
    When  buildLongLinkUrls 触发 stripeInit
    Then  GM_xmlhttpRequest 收到的 headers 中无 "User-Agent" 键

  Scenario: S6 Stripe init locale 跟随真实浏览器
    Given navigator.language = "ja"
    When  stripeInit 发出请求
    Then  请求体含 browser_locale=ja
    And   请求体含 elements_session_client[locale]=ja
    Given navigator.language = "zh-CN"
    Then  browser_locale=zh-CN,elements locale=zh

  Scenario: S7 checkout Accept-Language 跟随 navigator
    Given navigator.languages = ["ja","en-US"]
    When  postCheckout 发出请求
    Then  headers["Accept-Language"] === "ja,en-US;q=0.9"
    Given navigator.languages = ["zh-CN"]
    Then  headers["Accept-Language"] === "zh-CN"

  Scenario: S8 checkout 请求超时可失败
    Given fetch 对 checkout 永不响应
    When  postCheckout(body, token, 100)(测试注入 100ms)
    Then  100ms 后 reject,message 含 "超时"

  Scenario: S9 冷却跨面板重开仍然生效
    Given PH 链刚生成成功
    When  关闭面板并重新打开,再次点 PH
    Then  状态文案含 "等" 与 "秒"
    And   checkout 请求只发出过 1 次(fetch 计数 = 1)

  Scenario: S10 stripeFetch URL 必须经 URL 解析
    Given 候选 url "https://api.stripe.com/v1/payment_pages/cs_x/init"
    Then  通过(不 reject)
    Given url "https://evil.com/v1/payment_pages/cs_x/init"
    Then  reject,message 含 "非法 Stripe"
    Given url "https://api.stripe.com/v1/payment_pages/cs_x/../../evil/init"
    Then  reject
    Given url "http://api.stripe.com/v1/payment_pages/cs_x/init"
    Then  reject(非 https)

  Scenario: S11 Stripe init 失败仍回退 checkout 直链(回归)
    Given GM_xmlhttpRequest 返回 400
    When  buildLongLinkUrls
    Then  external = checkout 响应自带 url,不抛错

  Scenario: S12 畸形输入不产出半成品账号
    Given session 完全为 null(未登录)
    When  captureCurrent()
    Then  toast "当前未登录",accounts 数量不变
```

## Must NOT

- 不引入任何新 npm 依赖(只用 Node 内置)。
- 不改变既有公开行为:`generatePlusLink` 入参签名不变;Stripe init 失败必回退;动态文案仍走 textContent;accessToken 不落盘。
- 不放宽既有断言、不给测试加 skip。
- `GM_xmlhttpRequest` 的可达域不扩大:仍是 `api.stripe.com` 的 payment_pages init 唯一路径。
- 不修复与本次无关的预存问题(如 applySwitch 中 cookie 删除 catch、exportBackup 版本号写死)。

## Acceptance(完成定义)

- 上述 S1–S12 全部有持久化测试且通过;每条在 EVIDENCE 中映射到具体测试名。
- 覆盖率门禁对 userscript 文件生效,变更行 100% 覆盖,缺一门禁必须非零退出。
- 手工变异 ≥5 个,全部被杀死;变异脚本自身有负向对照(坏输入必须非零退出)。
- 真实加载执行:vm 沙箱中实际加载 userscript 并跑通 capture/checkout mock 链路(真实网络不可用,如实记录)。

## Revisions

- 2026-10-29 R1:S2 预期从「会话字段缺失」改为「当前未登录」——实现阶段确认 fetchSession 以 j.user 存在为登录判据,缺 user 直接返回 null,会话字段缺失分支只覆盖「有 user 无 account」(S1)。
- 2026-10-29 R2:S4 断言本身不变(active=null),测试增加等待 main 异步完成后再读存储;非行为变更。
- 2026-10-29 R3:S4 实际行为确认:main 在 parseSession 失败的终态分支不调用 setActive,active 保持原状(全新环境为未设置),断言从 ===null 改为 falsy;取代 R2 中 active=null 的描述。
