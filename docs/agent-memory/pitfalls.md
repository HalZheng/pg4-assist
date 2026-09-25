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
- 本机 git 走 GitHub 时依赖环境变量代理，schannel 会报 `CRYPT_E_NO_REVOCATION_CHECK`。
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
