# AGENTS.md — PG4 Assist 开发指南

> 供 AI 编码 agent 与协作者快速理解本项目：结构、运行方式、常见坑、如何排查「脚本在站点上不生效」。
> 页面技术特征的权威依据是 [`docs/pgAdmin 4 Web 技术特征与验证知识库.md`](docs/pgAdmin%204%20Web%20技术特征与验证知识库.md)。

## 项目是什么

**单文件、无构建、无依赖**的 pgAdmin 4 Query Tool（CodeMirror 6）离线增强层，
以 DevTools Snippet / 用户脚本 / Local Overrides 形式注入，适用于禁止安装浏览器扩展的环境。

- 不修改 pgAdmin 后端、不创建数据库连接、不外发任何数据（离线优先）。
- 当前交付物：`pg4-assist.js`（v2，约 3800 行，IIFE 单文件）。
- 对外 `VERSION` 保持克制：图标、样式及连续小修不逐次升级版本号；仅在明确计划发布或用户要求时调整。
  内部 `GRID_HOOK_REV` 用于替换监听器，独立于对外版本；`CONFIG_VERSION` 的迁移要求见下文。
- 旧实现（MV3 扩展、v1 自建 UI snippet）已归档至 `legacy/`，不要在那里加新功能。

## 项目记忆（跨 agent，开工先读）

本仓库面向多个 AI agent（Copilot / Claude Code / Cursor / Trae / WorkBuddy / Codex…），
项目记忆的**唯一事实来源**是 [`docs/agent-memory/`](docs/agent-memory/)：

- `decisions.md` —— 决策与用户偏好
- `pitfalls.md` —— 坑与「不要做什么」（硬约束）
- `log/YYYY-MM-DD.md` —— 会话流水，**只追加**

各平台私有目录（`.cursor/rules/`、`.trae/rules/`、`.workbuddy/memory/`、`CLAUDE.md`、
`.github/copilot-instructions.md`）里放的都是指向本目录的**薄指针**，正文只有一份。

- **各 agent 记忆目录的位置与格式互不相通**：Copilot 的 `/memories/repo/` 甚至在
  工作区之外（`%APPDATA%\...\workspaceStorage\<hash>\...`），无法被 git 追踪。
  因此：结论只写在私有记忆里 = 其他 agent 永远看不到。
- 会话中若有非显然的新结论，按 `docs/agent-memory/README.md` 的写入规范追加到对应文件，
  并以 `memory:` 前缀**单独提交**（可用 `git log --grep '^memory:'` 审计）。
- 切到其他平台时，先用 `docs/agent-memory/README.md` 里那段「开场提示词」引导它。

## 性能与默认值（改配置前必读）

- **实时诊断默认关闭**（`diagnosticsEnabled: false`）。它每次都对**整篇文档**重新分词，
  实测约 0.22 ms / 1000 字符；39 万字符的脚本单次近 93 ms，每 400 ms 触发一次，
  相当于持续占用约 1/4 个核。需要时在面板「设置 → 诊断」打开。
- 三处体积阈值（都是**字符数**，不是字节数，见文件顶部常量）：
  `MAX_DIAG_DOC_CHARS = 400_000`（超过则诊断放弃）、
  `ANALYZE_WINDOW_THRESHOLD = 200_000`（超过则补全/诊断只取光标附近
  `ANALYZE_WINDOW_BACK`+`ANALYZE_WINDOW_FWD` 的窗口）。
- `completionSource` 用 CM6 的 `doc.sliceString()` 取窗口，**不要**改回
  `ctx.state.doc.toString()` —— 后者每 90 ms 就把整篇文档拼成一个新字符串。
- 改动 `DEFAULT_CONFIG` 里任何默认值的**语义**时，必须递增 `CONFIG_VERSION`
  并在 `loadConfig()` 里加一次性迁移。因为配置合并是 `{...DEFAULT_CONFIG, ...saved}`，
  老用户 localStorage 里的旧值会盖掉新默认值。

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
- **监听器必须具名**才能被 `removeEventListener` 摘掉。`installGridCopyHook` 里
  那个「点菜单外面收起菜单」的 pointerdown 就踩过这个坑（匿名函数无法摘除，
  destroy → 重跑 每轮残留一个）。新增监听器时顺手在对应的 unhook 里补摘除。
- **`destroy()` 要删两个全局**：`window[NS]`（`__pg4Assist`）和 `window.__pg4`。
  后者是另一个对象，它的 `.core` 会强引用整份 schema graph。
- **`Core.observers` 会强引用 iframe 的 `win`**（等于整个 frame 的 JS 堆）。
  新增观察器必须带上 `frameEl`，由 `pruneObservers()` 回收。
  判失效要**同时**看两件事：`!frameEl.isConnected`（元素被摘掉）
  和 `sameOriginWindow(frameEl) !== o.win`（iframe 导航换了新窗口）——
  只看前者会漏掉导航这种情况。
- 例外：`watchFrameLoad` 的 load 监听器、`attachWindow` 里子 frame 的
  pointerdown **故意不摘** —— 它们不捕获 core，每次从 `window[NS]` 取当前实例，
  脚本重跑后自动指向新实例。改这些地方前先确认这个约定。
- git 访问 GitHub 走的是**环境变量里的传输层代理**（`$https_proxy`，端口会变，
  实测见过 4783 / 12484），不是 git 配置；schannel 会报
  `CRYPT_E_NO_REVOCATION_CHECK`，解法见 skill `git-push-behind-tls-proxy`。
