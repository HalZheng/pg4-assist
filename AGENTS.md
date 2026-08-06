# AGENTS.md — PG4 Smart Assist 开发指南

> 供 AI 编码 agent 与协作者快速理解本项目：如何构建、如何运行、常见坑、如何排查「扩展在站点上不生效」。
> 集成技术细节见 [`docs/pgadmin-cm6-bridge-integration.md`](docs/pgadmin-cm6-bridge-integration.md)。

## 项目是什么

Chrome / Edge **Manifest V3** 浏览器扩展，寄生式增强 pgAdmin4 网页版 Query Tool（CodeMirror 6）。

- 不修改 pgAdmin 后端、不创建数据库连接、不外发任何数据（离线优先）。
- 技术栈：TypeScript（严格模式）+ esbuild。
- 背景规格：`Pre-SPEC.md`（前情提要）与 `SPED.md`（开发实施规格）为权威依据。

## 快速开始

```bash
npm install                 # 首次；若 npm 11 拦截 install scripts：
npm approve-scripts --all   # 放行 esbuild 的 postinstall
npm run build               # 产物 → dist/（public/manifest.json 会复制进 dist/）
npm run watch               # 监听重建
npm run typecheck           # tsc --noEmit
npm run clean               # 清空 dist/
```

浏览器加载：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dist/` 目录。

## 架构

6 个打包入口（见 `esbuild.config.mjs`）：

| 入口 | 作用 |
|---|---|
| `background/service-worker.ts` | IndexedDB（快照/历史/使用频次）、Host 绑定、配置广播 |
| `content/content-script.ts` | ISOLATED world 编排：补全/诊断/悬停/危险拦截、Shadow DOM UI、Worker 客户端 |
| `bridge/main-world-bridge.ts` | MAIN world：发现 CM6 `EditorView`、转发事件、受控 dispatch（写入必须走 CM6 事务） |
| `worker/parser-worker.ts` | DDL 解析、补全候选、诊断、危险检测、快照 diff（blob Worker） |
| `options/options.ts` | 选项页（快照导入、Host 绑定） |
| `popup/popup.ts` | 扩展弹窗 |

消息流：

```
pgAdmin Query Tool / CM6  ←→  main-world-bridge (MAIN world)
        ↑ postMessage(协议帧 + nonce，见 src/types/messages.ts)
content-script (ISOLATED world)  ←→  parser-worker (blob URL Worker)
        ↑ chrome.runtime.sendMessage
service-worker (IndexedDB / chrome.storage.local)
```

关键安全约束（SPED §2.1、§4.2）：页面内容视为不可信；写入永远走 `view.dispatch({ changes, userEvent })` 保留 Undo/Redo；任何异常静默降级到原生 pgAdmin。

## 调试速查（新站点「不生效」排查顺序）

1. **注入**：页面 F12 → Console 过滤 `pg4`，应有 `[pg4] content: active context loaded {...}`。
   - 若无 → content script 未注入。MV3 中只有 `content_scripts.matches`（**静态声明**）决定注入；可选权限/插件内白名单都不会触发注入。需把站点 host 加进 `public/manifest.json` 的两个 `content_scripts.matches` 和 `host_permissions`。
2. **编辑器发现**：应有 `[pg4] bridge: started`、`[pg4] bridge: editor adopted cm-xxx`。
   - 若 `no CodeMirror 6 editor found` → ① 确认 Query Tool 已打开（不是主界面）；② 编辑器在**同源 iframe** 里，两个 content_scripts 都必须有 `"all_frames": true`。
3. **快照**：`active context loaded` 里 `hasGraph` 应为 true（options → Hosts 把 origin 绑定到已导入快照，快照 schema 数 > 0）。
4. **worker**：报 `SecurityError: Failed to construct 'Worker'` 是 MV3 跨源限制；content-script 已用 fetch+Blob 创建同源 worker，不要回退成直接 `new Worker(chrome.runtime.getURL(...))`。

## 关键坑（详见集成笔记）

- pgAdmin 打包**混淆隐藏了 CM6 的 `cmView` 属性**，DOM 上拿不到 view 实例 → bridge 用「webpack 挖 `EditorView` 类 + `EditorView.findFromDOM()`」方案（已内置）。
- 该 pgAdmin 的 `EditorView` **没有静态 `create` 方法** → 挖类只匹配 `findFromDOM`（不要加 `create` 条件）。
- 本机 git 全局代理 `http://127.0.0.1:7890`（Clash），需代理运行才能访问 GitHub；内网域名在代理下访问失败（内置浏览器/工具同理）。
