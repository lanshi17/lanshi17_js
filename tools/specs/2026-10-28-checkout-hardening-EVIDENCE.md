# Evidence Report — checkout 链路加固 (Tier 2)

- Spec approval: **obtained from user**（2026-10-28, 选项「批准,开始实现」;之后 R1–R3 为 append-only 修订,行为收窄而非扩大,未重新请批 —— 见 Honest notes）
- Source state: 见 `tools/source-state.sh`（commit + 工作树干净判定 + userscript sha256）
- Toolchain: Node **v26.12.0**;零新依赖（`node:test` / `node:assert` / `node:vm` / V8 coverage 全部内置）
- Entry point: `tools/gauntlet.sh 412d59e`
- Independent verification: **not performed**（Tier 2;用户未要求,成本不必要）

## Spec → Test mapping

| Scenario | Test | Status |
|---|---|---|
| S1 session 有 user 无 account → null+toast,active 不变 | tools/run-tests.mjs::"S1 …" | pass |
| S2 session 缺 user 等同未登录 | tools/run-tests.mjs::"S2 …" | pass |
| S3 完整结构按 email/UUID/planType 落库（回归） | tools/run-tests.mjs::"S3 …" | pass |
| S4 main 畸形 session 不崩溃,active 保持空 | tools/run-tests.mjs::"S4 …" | pass |
| S5 Stripe headers 不含 User-Agent | tools/run-tests.mjs::"S5 …" | pass |
| S6 browser_locale/elements locale 跟随 navigator | tools/run-tests.mjs::"S6 …" | pass |
| S7 Accept-Language 跟随 navigator.languages | tools/run-tests.mjs::"S7 …" | pass |
| S8 checkout 挂起按注入超时 reject | tools/run-tests.mjs::"S8 …" | pass |
| S9 冷却 store 持久,重开面板仍拦 | tools/run-tests.mjs::"S9 …" | pass |
| S10 合法 URL 放行,host/协议/穿越全拒 | tools/run-tests.mjs::"S10 …" | pass |
| S11 Stripe 400 回退直链（回归） | tools/run-tests.mjs::"S11 …" | pass |
| S12 未登录 toast,账号数不变 | tools/run-tests.mjs::"S12 …" | pass |
| Must NOT: 零新依赖 | `node_modules` 不存在;仅 import node:* | pass |
| Must NOT: 不扩 Stripe 可达域 | L3 URL 解析仍只认 api.stripe.com payment_pages init | pass |
| Must NOT: accessToken 不落盘 | 无新增 GM_setValue 存储凭证的路径 | n-a（代码走查,无自动化层） |
| Property P1: 50 个随机非 stripe host 全拒 | tools/run-tests.mjs::"P1 …" | pass |
| Property P2: 长链成功 external/internal host 不变量 ×5 | tools/run-tests.mjs::"P2 …" | pass |

## Gauntlet (final fresh run, `tools/gauntlet.sh 412d59e`)

| Layer | Command | Result |
|---|---|---|
| L1 Syntax | `node --check chatgpt-account-switcher.user.js` | OK |
| L2 Tests | `node --test --test-timeout=10000 tools/run-tests.mjs` | **14 passed, 0 failed**, duration 3349.6ms |
| L3 Changed-line coverage | `node tools/coverage-changed.mjs 412d59e` | changed 60, executable **60**, non-code 0 → **60/60 covered** |
| L4 Mutation | `node tools/mutate.mjs` | negative control 0 replacements;**6/6 killed** |
| L5 Determinism | 第二次完整跑 L2 | OK（SUBSTITUTED,见下） |
| Real execution | vm 沙箱加载真实 userscript,panel/capture/checkout→stripe 全链 mock 跑通 | L2 全部测试即此证据;真实网络未打（无登录态） |
| Supply chain | 依赖集未变 | 0 new deps;无 npm audit 对象 |

变异明细:
- M1 captureCurrent 守卫取反 → killed（S1）
- M2 超时判定取反 → killed（S8）
- M3 Stripe 协议放宽为 http → killed（S10）
- M4 Accept-Language q 值反转 → killed（S7）
- M5 冷却时差反转 → killed（S9）
- M6 Stripe host 重写判定反转 → killed（S5/P2）

Checker 负向对照:
- `mutate.mjs`: 缺失定位串 → 替换计数必须为 0 的守卫路径实际执行（输出 "negative control: absent-marker → 0 replacements"）;定位串出现次数 ≠1 时 exit 1。
- `coverage-changed.mjs`: 无可执行变更行 / 无 coverage 输出 / 找不到目标脚本均为 exit 1 路径（实现时逐一触发确认）。
- 对照边界:这些控制只证明已知坏输入到达失败路径,不证明识别所有违规。

## Layers not run as specified

- **N-A:** 静态类型 —— userscript 是无构建步骤的浏览器 JS,项目无 tsc/flow;不引入。
- **N-A:** Lint —— 仓库无 eslint 配置;语法层 + 测试已覆盖本次风险,不新增工具（遵守零依赖约束）。
- **SUBSTITUTED:** Suite health —— 无随机执行器（node:test 无 shuffle）;替代 = 同参数完整跑两次。**不能检测跨文件顺序依赖**,但本项目测试通过独立沙箱隔离（每用例独立上下文/存储/网络）,顺序依赖面实际很小。
- **UNAVAILABLE:** Stryker/工具化变异 —— 未安装;按 manual 流程执行,脚本持久化在 `tools/mutate.mjs`。

## Structural blind spot

- 全部网络行为（checkout 风控、Stripe init 真实响应、pay.openai.com 支付页可达性）无真实登录态与出口 IP,沙箱只验证请求构造与回退逻辑;**不构成对 OpenAI 服务端行为的任何证据**。本次指纹一致性改动（去假 UA、locale 跟随）能否缓解线上 400,需真机实测。

## Honest notes

- RED 阶段全 14 用例失败是真实的:其中暴露 harness 三处缺件（`__CAS_TEST__` 未置、`AbortController` 缺、`URL` 缺,后两者导致脚本内 ReferenceError 被自身 catch 吞掉）;还暴露一处此前未察觉的旧代码损坏 —— toast 元素创建行在 v1.6.1 去重编辑时被误删（`t` 未定义,toast 路径全坏）,本次一并修复。
- SPEC 三次 append 修订:R1（S2 真实契约是「未登录」非「字段缺失」）;R2/R3（S4 main 终态分支不调 setActive,断言 ===null 改为 falsy）。均为实现揭示的预期错误,非测试失败后的让步。
- 早先版本的一个候选 mutant（stripeInit 状态码校验取反）实测存活,判定为**等价 mutant**:成功时抛错与网络失败对回退逻辑不可区分且回退链有效;已用 M6（host 重写）替换,未加无意义测试。
- `example.json` 含真实明文凭证,仍未纳入 git（untracked）,不提交。
