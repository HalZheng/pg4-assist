# 坑与「不要做什么」

> 面向所有 agent。每条都是踩过的，别凭直觉推翻。技术细节的权威依据是
> `docs/pgAdmin 4 Web 技术特征与验证知识库.md`。

## 不要声称已修复的问题

- **WeChat 输入法触发黑色小条**遮挡首个补全项并破坏 Tab/Enter。用户确认换 US 键盘可规避。
  合成的 IME 事件模拟**无法**复现真实微信输入法行为，相关猜测性改动已回撤。
  v2.2.5 是当时的基线。**不要写"IME 问题已修复"**，除非有真实微信输入法下的复现验证。
- v2.2.6 之后新增的「复制菜单」功能与 IME 无关，不要把它当成 IME 修复。

## DOM 与选择器（pgAdmin 结果区）

- 结果工具栏真实按钮用 `data-label="复制"`（无选中时 disabled，常在 span 内）和
  `data-label="复制选项"`（默认无 title/aria）。
  **不要**用模糊的 title 匹配去找——会把下拉菜单误判成主按钮。
- 结果表头文本混合了名称与类型（如 `Id[PK] uuid`）；内层 `[data-column-key]` 才是原始字段名（`Id`）。
- CsvHelper 的默认字段分隔符是**制表符**，尽管类名叫 CSV。

## 平台/工具

- **Copilot `/memories/repo/` 不在工作区内**（在 workspaceStorage 下），无法被本仓库 git 追踪。
  换工作区路径会换 hash 目录，等于记忆"消失"。重要结论必须回写 `docs/agent-memory/`。
- **Qoder 的记忆目录同样在工作区外**：`~/.qoder-cn/memory/`（用户级）与
  `~/.qoder-cn/projects/<工作区slug>/memory/`（项目级，slug 由路径转写而来）。
  2026-09-26 核查时两者均为空。**不要**把结论只写在那里；Qoder 原生读 `AGENTS.md`，
  因此仓库内不需要为它另建 stub，私有目录里只放指向 `docs/agent-memory/` 的指针。
- **远端拓扑按机器而异，不要凭记忆假设推送目标**：项目级约定是双远端
  （`github`=公开 GitHub、`origin`=内网 GitLab，见 `decisions.md`），但部分机器只配了 GitHub 单远端
  （当前这台：`origin → gh-proxy 镜像的 GitHub`，无 GitLab、无 `github` 远端）。
  任何涉及 push / 建分支 / 清理远端的操作前先 `git remote -v` 确认。
  失效条件：当台机器补配远端后以实测为准；**单远端不构成"双远端"那条记忆有误的证据**。
  - 更正（2026-09-28）：本机**已不是单远端**——当日本机新增 `github → https://github.com/HalZheng/pg4-assist.git`，
    推送改走它（见下「推送通道」）。原文「无 `github` 远端」仅对 2026-09-28 之前有效。
- 本机 git 走 GitHub 时依赖环境变量代理，schannel 会报 `CRYPT_E_NO_REVOCATION_CHECK`。
  - 更正（2026-09-28）：本次推送时 `$env:https_proxy` / `$env:HTTPS_PROXY` **为空**且 `curl https://github.com` 直连 200，
    未用到环境变量代理；不排除时段性直连不可达，需要代理的情形仍以本条为准。
- **推送通道（2026-09-28 实测）**：本机 `git push` 走 **`github` 远端**能够成功；走 `origin`（gh-proxy）会报
  `remote: Invalid username or token. Password authentication is not supported for Git operations.`
  - 原因：凭据管理器里 gh-proxy 存的是**密码型**凭据（GitHub 早已不支持 git 密码认证）；
    而 GCM（`git credential-manager github list`）里 GitHub 账号 `HalZheng` 的凭据有效。
  - 证据：`git push github main` → `0e49cfe..04603ee` 成功；`git ls-remote github main` 与本地一致；
    `git fetch origin` 后 `origin/main` 也同步到 `04603ee`（gh-proxy 读路径正常、不滞后）。
  - 适用范围：仅本机；换机器以 `git remote -v` + 实测为准。
    失效条件：gh-proxy 的凭据换成 PAT、或凭据管理器被清空时需重测。
- **本机没有 `gh` CLI**（`gh --version` → CommandNotFound）：GitHub 插件的 `yeet`、`gh-fix-ci` 等技能依赖 `gh`，本机不可用。
  Trae code-mode 沙箱（`integrated_code_mode`）内 `run_mcp` **看不到**插件 MCP server（`mcp_plugin_GitHub_github` 等候选名均报
  `MCP server is not found`）；需要 API 级 GitHub 操作时只能由主会话调用 MCP 工具。
- `.gitignore` 忽略了 `.vscode/`：**不要**把需要团队共享的配置放进 `.vscode/`。

## 代码层（摘要，详见 AGENTS.md「关键坑」）

- Query Tool 在**同源 iframe** 里，外层 DIV 与 IFRAME **共用同一个 id** → 必须 `querySelectorAll('iframe')`。
- 取真 `__webpack_require__` 只能走 `webpackChunk.push` 第三个回调；**不能**重放 module factory。
- **不能** `appendConfig(autocompletion({override}))`（Config merge conflict），只能就地替换已解析配置的 `override[0]`。
- 每个 `EditorView` 只挂一次扩展（`view.__pg4Slot`），`StateEffect.appendConfig` 不可撤销。
- 监听器必须**具名**才能 `removeEventListener`；新增监听器时同步在对应 unhook 里补摘除。
- `destroy()` 要删 `window.__pg4Assist` 和 `window.__pg4` **两个**全局。
- `Core.observers` 会强引用 iframe 的 `win`；判失效要**同时**看 `!frameEl.isConnected`
  和 `sameOriginWindow(frameEl) !== o.win`（只看前者会漏掉 iframe 导航）。
- 例外：`watchFrameLoad` 的 load 监听器与 `attachWindow` 中子 frame 的 pointerdown **故意不摘**，
  它们每次从 `window[NS]` 取当前实例。改之前先确认这个约定。
- **不要从「编辑区补全弹层能跟随暗色」推断自绘 DOM 也会跟随**。补全弹层由 CodeMirror 6 渲染，
  主题来自 pgAdmin 自己注入的 `EditorView.theme`，我们没写一行配色；我们自绘的右键菜单/面板是普通 DOM，
  只依赖 `var(--color-bg)` / `var(--color-fg)` 是否真被 pgAdmin 暗色主题重新赋值——**仓库里没记录这套主题机制**
  （`grep "dark|theme|主题"` 在 `pg4-assist.js` 与 `docs/` 均无命中）。
  所以：不要凭猜测硬编码一套深色色值；要改先从真机拿到主题信号。
- 删除工具栏改写后，`__pg4GridCopyUnhook` 里那段「还原 rev≤10 遗留改写」的清理**不能顺手删**：
  已经跑过旧版脚本的浏览器里，工具栏按钮还带着我们加的 class 和被覆盖的 title。
