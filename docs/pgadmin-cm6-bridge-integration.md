# pgAdmin4 × CodeMirror 6 集成技术笔记

> 记录对 pgAdmin4 网页版 Query Tool 结构的实测调查，以及「如何在该环境下发现并接管 CM6 编辑器」的可复用结论。
> 结论基于 2026-08-06 对两个 pgAdmin 4 站点（登录后）的浏览器实测：
> `https://pgadmin-uat.dev.edutechonline.org/browser/` 与 `https://sfs-pg-dev.acscloud.net/browser/`。两站结构一致（见 §6 多环境实测对比）。
> 阅读对象：后续维护本扩展或移植到其他 pgAdmin 环境的开发者 / AI agent。

---

## 1. 页面结构结论（实测）

- **顶层** `/browser/` 是 pgAdmin 主界面：对象浏览器树、工具栏。**顶层没有 SQL 编辑器**。
- **Query Tool 编辑器位于同源 iframe**：URL 形如 `/sqleditor/panel/<id>?is_query_tool=true&sgid=..&sid=..&did=..`，iframe `id` 形如 `id-query-tool_<随机数>`，每个数据库连接一个 iframe。
- 若扩展在 iframe 里不工作 → 检查 `manifest.json` 的 `content_scripts` 是否都声明了 **`"all_frames": true`**（默认只在顶层注入）。

### CM6 编辑器 DOM（实测）

```
div.cm-editor ͼ1 ͼ2 ͼ4 ͼ1g        ← 根元素，class 含 CM6 随机 style 类名（ͼ 前缀）
├─ div.cm-announced (aria-live)
├─ div.cm-scroller
│  ├─ div.cm-gutters.cm-gutters-before
│  │  └─ div.cm-gutter.cm-lineNumbers > div.cm-gutterElement
│  └─ div.cm-content[contenteditable="true"]
└─ ...
```

- 根元素 `.cm-editor` **只有 `class` 属性**：`Object.keys(el) === []`，**没有 `cmView`**。
- 结论：标准 CM6 会把 view 挂在 `dom.cmView`，但该 pgAdmin 的打包**混淆/隐藏了该属性**，DOM 上无法直接拿 view。

## 2. view 实例为什么拿不到，以及怎么拿到（核心方案）

### 失败路径（别走）
- `el.cmView` / `el.view` / `el.editor`：实测 `Object.keys` 为空，拿不到。
- 深度遍历 DOM 后代找「有 `dispatch + state.doc + coordsAtPos` 的对象」：实测为空。
- 从 `window` 可达对象图广度遍历（2 万节点）：实测 `deepFoundView: false`。

### 可行路径（已实测验证 ✅）
该 pgAdmin 用 **webpack 5**，模块系统暴露在 `window.webpackChunk`（实测 6 个 chunk、14045 个模块）。方案：

1. 收集所有 chunk 的模块 factory：`webpackChunk[i][1]` 形如 `{ moduleId: factory }`。
2. 用自研 **mini-require**（带缓存、逐个执行 factory）重建模块图。
3. 遍历模块 exports，找**带静态 `findFromDOM` 方法的类** → 即 `@codemirror/view` 的 `EditorView`（实测模块 id `561506`，导出名 `EditorView`，类名被混淆为 `p`）。
4. 调用 `EditorView.findFromDOM(document.querySelector('.cm-editor'))` → 返回真实 view 实例。

实测返回的 view：`hasDispatch=true`、`state.doc` 可读（能取到编辑器 SQL）、`coordsAtPos`/`focus` 可用。`findFromDOM` 内部与构造函数使用**同一个（被混淆的）属性名**，因此即使属性名变了也能反查成功。

> ⚠️ **关键坑**：该 pgAdmin 的 `EditorView` **没有静态 `create` 方法**（实测 `hasCreate: false`）。挖类时若用 `findFromDOM && create` 两个条件会匹配失败，**只匹配 `findFromDOM` 即可**（其存在性即可唯一标识 EditorView 类）。

### webpack 模块细节（实测快照）
- `webpackChunk` 元素结构：`[chunkIds, { moduleId: factory }, runtime]`；第三个 runtime 只是 `(id)=>__webpack_require__(id)`，**没有** `.c`/`.m` 缓存，所以不能直接拿缓存，需自建 mini-require。
- `EditorView` 模块（id 561506）exports 即标准 `@codemirror/view` 全量导出：`BlockType`、`Decoration`、`ViewPlugin`、`ViewUpdate`、`WidgetType`、`drawSelection`、`highlightActiveLine`、`gutters` 等。
- view 实例自身属性（混淆后类名 `p`）：`plugins`、`contentDOM`、`scrollDOM`、`dom`、`dispatchTransactions`、`dispatch`、`viewState`、`observer`、`inputState`、`docView`、`styleModules` 等——确认是完整 EditorView 实例。

## 3. pgAdmin 全局对象（备用信息）

`window.pgAdmin`：`Browser`、`Tools`、`csrf_token(_header)`、`qt_default_placeholder`、`enable_psql` 等。
`window.pgAdmin.Tools`：实测仅 `FileManager`、`SQLEditor`（新版把 QueryTool 归到 `SQLEditor`）。
传统 pgAdmin（Backbone）可从 `pgAdmin.Tools` 拿工具视图引用，但**新版本更可靠的是 webpack 挖类方案**，无需依赖这些全局。

## 4. 部署与调试要点

- **注入**：`content_scripts.matches` 必须**静态声明**目标站点 host（MV3 中只有它决定注入；可选权限 `optional_host_permissions` 与插件内 host 白名单都不会触发注入）。两个 content_scripts（isolated + MAIN world）都要覆盖，且都要 `all_frames: true`。
- **Worker**：content script 里 `new Worker(chrome.runtime.getURL('parser-worker.js'))` 会被 MV3 以跨源拒绝（`SecurityError`）。解法：`fetch` 源码 → `Blob` → `URL.createObjectURL` 建同源 worker（`{type:'module'}`）。`parser-worker.js` 是单文件、无外部 import、无 `chrome.*`，故 blob worker 可行。
- **日志约定**：关键状态用 `console.info`（默认可见），前缀 `[pg4]`：
  - `[pg4] content: active context loaded {origin, snapshotId, hasGraph, schemas, snippets}`
  - `[pg4] bridge: started (MAIN world)`
  - `[pg4] bridge: EditorView found via webpack (module 561506, export EditorView)`
  - `[pg4] bridge: editor adopted cm-xxx`
- **网络**：git 全局代理 `127.0.0.1:7890`（Clash）；内网域名在代理下访问失败（公司环境建议给内网域名配直连）。

## 5. 移植到其他 pgAdmin 环境的检查清单

1. `content_scripts.matches` 是否包含目标站点 host？是否 `all_frames: true`？
2. 打开 Query Tool 后，是否有 `.cm-editor` 元素？`Object.keys(el)` 是否为空（view 是否被隐藏）？
3. `window.webpackChunk` 是否存在？mini-require 能否挖到带 `findFromDOM` 的类？
4. 若 view 的静态方法名也被混淆（`findFromDOM` 不存在），需再调整匹配特征（如匹配有 `state`/`dispatch` 行为的类或用 `EditorView.findFromDOM` 的替代发现路径）。

## 6. 多环境实测对比（2026-08-06）

| 项目 | sfs-pg-dev.acscloud.net | pgadmin-uat.dev.edutechonline.org |
|---|---|---|
| Query Tool 位置 | iframe `/sqleditor/panel/*` | 相同 |
| `.cm-editor` ownKeys | `[]`（无 `cmView`） | 相同 |
| `webpackChunk` chunks | 6（14049 模块） | 6（14045 模块） |
| `EditorView` 模块 id | `561506` | `561506` |
| `EditorView.create` | 无 | 无 |
| `EditorView.findFromDOM` | 有（实测可拿 view） | 有（实测可拿 view） |
| `pgAdmin.Tools` | `FileManager` / `SQLEditor` | 相同 |
| view 混淆类名 | `f` | `p`（仅压缩差异，无影响） |

**结论**：两站为同一构建基线（模块 id 一致），CM6 集成方式相同，webpack 挖类 + `findFromDOM` 方案**通用**；模块数/混淆类名差异为构建小差异，不影响方案。
