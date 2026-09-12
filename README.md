# lanshi17_js

Tampermonkey(油猴)用户脚本集合。GitHub:https://github.com/lanshi17 有ai国外模型需要的可以访问:https://linxi.chat

## 解除学习通的code题目不能复制粘贴的功能
1. 仅在湖南农业大学的高级算法设计课程作业通过测试
2. 如果有补充欢迎联系!

## ChatGPT 多账号一键切换(chatgpt-account-switcher.user.js)

在 chatgpt.com 保存多个账号的 sessionToken(ST),悬浮球 / 油猴菜单一键切换,支持备份导入导出。
原理:网页登录态 = HttpOnly cookie `__Secure-next-auth.session-token`,用 GM_cookie 删旧写新后刷新页面。

### 安装
1. 安装 [Tampermonkey](https://www.tampermonkey.net/)(GM_cookie 仅 Tampermonkey 支持)
2. 通过 raw 链接安装:https://raw.githubusercontent.com/lanshi17/lanshi17_js/master/chatgpt-account-switcher.user.js
   (或在 Tampermonkey 中新建脚本,粘贴 `chatgpt-account-switcher.user.js` 全部内容保存)

### 功能
- 悬浮球 + 油猴菜单双入口;面板深/浅色自适应(跟随系统)
- 「保存当前账号」捕获当前登录 ST;「导入」支持 会话 JSON / 裸 ST / 备份 JSON(可批量)
- 「导入」支持任意结构 JSON:账号对象含 sessionToken / refresh_token / access_token 任一字段即可
  (兼容本脚本备份、sub2api、CLIProxyAPI 等导出);仅带 API/OAuth 凭证(无 ST)的账号
  标记「缺ST」,网页切换仍需 ST——登录该账号后点「保存当前账号」即自动合并补齐
- 一键切换账号,超长 ST 自动分块写入;切换失败有 toast 提示
- 「备份」一键导出全部账号 JSON 到剪贴板,导入可批量还原
- 已保存账号的会话失效时,页面顶部横幅提示并引导处理
- 两步删除确认,误触不会丢账号

### 安全须知
- ST 是账号钥匙,明文存在本机 Tampermonkey 存储里(仅本机本浏览器),勿导出分享

- 在 chatgpt.com 执行“登出所有设备”会使所有已存 ST 全部失效
- ST 过期(约 30 天滚动)后,需在该账号登录状态下点「保存当前账号」重新捕获
- 本脚本只读写你自己的会话 cookie,不外发任何数据

## 许可证

本项目基于 [MIT License](./LICENSE) 发布(Copyright (c) 2025 胖胖的我)。
各用户脚本头部均含 `@license MIT` 元数据声明;二次分发请保留许可证与版权声明。
