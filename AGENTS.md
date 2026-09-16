# AGENTS.md — PG4 Assist 开发指南

> 供 AI 编码 agent 与协作者快速理解本项目：结构、运行方式、常见坑、如何排查「脚本在站点上不生效」。
> 页面技术特征的权威依据是 [`docs/pgAdmin 4 Web 技术特征与验证知识库.md`](docs/pgAdmin%204%20Web%20技术特征与验证知识库.md)。

## 项目是什么

**单文件、无构建、无依赖**的 pgAdmin 4 Query Tool（CodeMirror 6）离线增强层，
以 DevTools Snippet / 用户脚本 / Local Overrides 形式注入，适用于禁止安装浏览器扩展的环境。

- 不修改 pgAdmin 后端、不创建数据库连接、不外发任何数据（离线优先）。
- 当前交付物：`pg4-assist.js`（v2，约 3200 行，IIFE 单文件）。
- 旧实现（MV3 扩展、v1 自建 UI snippet）已归档至 `legacy/`，不要在那里加新功能。

## 快速开始

无构建步骤。改完 `pg4-assist.js` → pgAdmin 页面 F12 → Sources → Snippets → 粘贴全文 → Ctrl+Enter。
重复运行幂等；重载前先 `window.__pg4.destroy()`。

## 架构（pg4-assist.js 内部分区）

单 IIFE，按 `§0–§14` 分区：配置 → 工具 → SQL 词法 → DDL 解析 → Schema 索引 →
IndexedDB 存储 → 语句上下文分析 → 候选生成排序 → 诊断 → 智能粘贴 →
**CM6 模块桥**（webpack 挖掘）→ **编辑器接管**（Session / 补全 hook）→
控制面板 UI → Core（数据 + 会话 + frame 注入）→ 引导。

核心思路：从 webpack 运行时取出 **pgAdmin 自己那份 CodeMirror 6 模块实例**，
注册原生 CM6 扩展（autocompletion / hoverTooltip / Decoration / domEventHandlers），
补全弹层 / 键盘导航 / 主题全部由 CM6 负责。顶层实例负责扫描接管所有同源 iframe 里的编辑器。

## 调试速查（「不生效」排查顺序）

1. **启动**：页面 F12 → Console 过滤 `pg4`，应有 `PG4 Assist v2.x 已启动 · 接管 N 个编辑器`。
   - 若无 → 脚本没跑；确认在**顶层页面**上下文运行（不用切 iframe）。
2. **编辑器接管**：`window.__pg4Assist.sessions.size` 应 ≥ 1。
   - 若为 0 → 确认 Query Tool 已打开；稍等 4 秒轮询或手动 `window.__pg4.attachAll()`；
     看 Console 是否有 `CodeMirror 模块定位失败`（webpack 挖掘问题，见知识库 §2.3）。
3. **快照**：`window.__pg4Assist.graph` 应非空（点右下角 PG 面板 → 快照 → 导入 DDL；
     持久化在 IndexedDB `pg4-assist` 库，重跑自动恢复）。
4. **调试入口**：`window.__pg4`（config / importDdlText / attachAll / destroy +
     analyzeContext / buildCandidates / runDiagnostics / transformPaste 等纯函数）。

## 关键坑（详见知识库 §2）

- Query Tool 在**同源 iframe**里；外层 DIV 与 IFRAME **共用同一个 id**，必须
  `querySelectorAll('iframe')`；`cmView` 挂在 `.cm-content` 上。
- 取真 `__webpack_require__` 只能走 `webpackChunk.push` 第三个回调；**不能**重放 module
  factory（模块副本 facet 身份不一致，扩展不生效）。
- **不能** `appendConfig(autocompletion({override}))`（`Config merge conflict`）；只能就地替换
  已解析配置里的 `override[0]`。
- `StateEffect.appendConfig` 不可撤销：每个 `EditorView` 只挂一次扩展（`view.__pg4Slot`），
  通过 `slot.session` 读当前会话。
- 本机 git 全局代理 `http://127.0.0.1:7890`（Clash），需代理运行才能访问 GitHub；
  内网域名在代理下访问失败。
