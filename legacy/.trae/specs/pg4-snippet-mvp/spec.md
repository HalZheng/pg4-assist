# PG4 Smart Assist Snippet 移植 Spec

## Why

公司域控禁止随意安装浏览器扩展,导致现有 PG4 Smart Assist(MV3 扩展位于 `/workspace`)无法分发。需将核心增强能力移植为 DevTools Snippet 形态:用户在 pgAdmin4 页面 DevTools 中手动运行一次 snippet,即可获得离线 Schema 驱动补全、实时诊断、对象悬停文档、智能粘贴、危险语句拦截等能力,绕过扩展安装限制。

## What Changes

### 新增

- **新项目** `/pg4-smart-assist-snippet`,与现有 `/workspace` 完全独立,代码全部用纯原生 JS 重写(ES2024+,无构建)。
- **单文件 Snippet 部署**:整个增强层打包成单个 `pg4-snippet.js` 文件,用户粘贴到 DevTools → Sources → Snippets 中运行。
- **CM6 编辑器直接接管**:沿用 `webpackChunk` + `EditorView.findFromDOM` 方案,但在 MAIN world 内直接持 view 实例,所有写入直接 `view.dispatch({changes, userEvent})`,**完全移除 bridge postMessage + nonce 协议**。
- **Blob URL Worker + 主线程降级**:DDL 解析、补全候选计算、诊断三个重活走 Blob URL Worker(同源);若 pgAdmin CSP 拦截 Blob Worker,自动降级为主线程同步执行。
- **页面源存储**:DDL 快照存 IndexedDB(库名 `pg4-smart-assist`,建在 pgAdmin 页面源下);配置存 `localStorage`(所有 key 加 `pg4.` 前缀)。
- **最小化 UI**:页面右下角单一浮动按钮,点击展开抽屉,仅含「导入快照 / 切换活跃快照 / 删除快照」三项操作。其余配置(diag 开关、paste 模式、danger 开关、maxCandidates、补全快捷键、showSystemTables)全部硬编码在 snippet 顶部 `CONFIG` 常量中。
- **自动重载活跃快照**:Snippet 启动时从 IndexedDB 读取 `localStorage["pg4.activeSnapshotId"]` 指向的快照,自动加载到内存,无需重新导入。
- **MutationObserver 多编辑器接管**:Snippet 运行一次后,新打开的 Query Tool tab(同源 iframe)由 MutationObserver 自动发现并接管。
- **跨 tab 配置同步**:监听 `window` 的 `storage` 事件,活跃快照切换、CONFIG 变更自动同步到同源其他 tab。
- **Local Overrides 兼容预留**:Snippet 顶层检测运行环境(Snippet 模式 vs Local Overrides 自动注入模式),两种模式行为一致,Local Overrides 不需额外改造。

### 改造(从原 SPED 继承,实现方式变更)

- **CM6 编辑器发现**:从 `main-world-bridge.ts` 的 MAIN world 注入 + postMessage 转发,改为 snippet 直接在 MAIN world 调用 `findEditorViewFromWebpack()` 持有 view。
- **编辑器写入**:从 bridge `apply-completion` 消息,改为直接 `view.dispatch({changes: {from, to, insert}, selection: {anchor}, userEvent: "input"})`。
- **补全交互编排**:从 content-script + worker RPC 双向通信,改为本地模块直接调用,Worker 仅作为计算 offload。
- **危险语句拦截**:从扩展层 capture-phase click 监听,改为页面级 `document.addEventListener("click", ..., true)` 直接监听执行按钮。
- **快照生命周期管理**:从 options 页表单,改为页面内浮动抽屉。

### 移除

- **Service Worker / Background**:Snippet 无后台。
- **Bridge postMessage + nonce 协议**:单 world 直接访问 view,无需跨 world 通信。
- **`chrome.storage.local` / `chrome.runtime.sendMessage`**:无扩展 API。
- **跨 tab `chrome.runtime.sendMessage` 广播**:改为 `storage` 事件。
- **Options 页 / Popup**:无扩展 UI 入口,改为页面内浮动按钮 + 抽屉。
- **片段库**:用户决定砍掉,片段直接用 DevTools Snippets 自身管理。
- **查询历史检索面板**:pgAdmin 自带历史;且为了砍 UI 复杂度。**注**:仍保留「执行时记录到 IndexedDB」的写入逻辑,仅去掉 UI,后续可恢复。
- **JSONB 结果区域复制**:P1 功能,本次不做。
- **DDL 快照 Diff 视图**:P2 功能,本次不做。
- **JSONB 结构树预览**:P2 功能,本次不做。

## Impact

- **影响代码**:与 `/workspace` 现有扩展代码完全独立,新项目从零开始,仅参考算法思路。
- **影响数据**:DDL 快照从 `chrome-extension://` 源迁移到 pgAdmin 页面源;若用户已有旧扩展数据,需提供 `.pg4snap.json` 导入迁移路径。
- **影响 pgAdmin**:零侵入,snippet 失败必须静默降级,pgAdmin 原生行为不受影响。
- **影响安全边界**:DDL/查询历史/使用频次落在 pgAdmin 页面源,理论上若 pgAdmin 被攻破可被读取。可接受(DDL 是公司自有 schema,查询历史是用户自己写的 SQL,敏感度低)。
- **影响部署**:用户首次使用需手动粘贴 snippet 并运行;后续每次刷新页面需重新运行一次 snippet。日常使用场景:早上跑一次,整天用;仅刷新/切 iframe 需重跑。

## ADDED Requirements

### Requirement: 单文件 Snippet 部署

The system SHALL be deployable as a single self-contained `.js` file that the user pastes into DevTools → Sources → Snippets. The snippet SHALL run in the page's MAIN world and SHALL NOT require any build step, bundler, or external dependency.

#### Scenario: 单文件粘贴运行
- **WHEN** 用户把 `pg4-snippet.js` 全部内容粘贴到 DevTools Snippets 新建片段并按 Ctrl+Enter 运行
- **THEN** snippet 在当前 pgAdmin 页面 MAIN world 中初始化
- **AND** 控制台输出 `[pg4] snippet: started` 日志
- **AND** 页面右下角出现浮动齿轮按钮
- **AND** 若已有活跃快照,自动加载并启用补全/诊断/hover

#### Scenario: 重复运行幂等
- **WHEN** 用户在同一页面重复运行 snippet
- **THEN** 已存在的浮动按钮、Worker、MutationObserver、事件监听不被重复创建
- **AND** 控制台输出 `[pg4] snippet: already active, skipping` 提示

### Requirement: 纯原生 JS ES2024+ 单文件实现

The system SHALL be implemented in pure native JavaScript (no TypeScript, no JSX, no transpilation) targeting ES2024+ features. The source code SHALL be a single `.js` file with no `import`/`export` statements (or all such statements inlined at delivery time).

#### Scenario: 现代特性使用
- **WHEN** 开发者编写 snippet 代码
- **THEN** 可使用 class fields、top-level await、private fields `#`、`Object.hasOwn()`、`Array.prototype.at()`、`Promise.withResolvers()`、Iterator helpers 等 ES2024+ 特性
- **AND** 不引入任何 npm 依赖,不使用构建工具

### Requirement: CM6 编辑器直接接管

The system SHALL discover CodeMirror 6 `EditorView` instances by scanning `window.webpackChunk` for a class with a static `findFromDOM` method, then call `findFromDOM(el)` on each `.cm-editor` element to obtain the view instance. The system SHALL hold view instances directly in memory and SHALL perform all writes via `view.dispatch({changes, selection, userEvent: "input"})` to preserve Undo/Redo.

#### Scenario: 编辑器发现成功
- **GIVEN** pgAdmin4 Query Tool 已打开,`.cm-editor` 元素存在
- **WHEN** snippet 运行并扫描 `window.webpackChunk`
- **THEN** 找到带 `findFromDOM` 静态方法的类(模块 id 可能被混淆)
- **AND** 调用 `findFromDOM(document.querySelector('.cm-editor'))` 返回有效 view 实例
- **AND** 控制台输出 `[pg4] editor adopted cm-<id>` 日志

#### Scenario: 编辑器发现失败
- **WHEN** snippet 无法在 webpack chunk 中找到 EditorView 类,或 `findFromDOM` 返回 null
- **THEN** 控制台输出 `[pg4] no CodeMirror 6 editor found`
- **AND** MutationObserver 继续监听 DOM 变化,新出现的 `.cm-editor` 触发重试
- **AND** 不抛出未捕获异常,pgAdmin 原生行为不受影响

#### Scenario: 直接 dispatch 写入
- **WHEN** 用户从补全菜单选择候选项
- **THEN** snippet 调用 `view.dispatch({changes: {from, to, insert}, selection: {anchor: from + insert.length}, userEvent: "input"})`
- **AND** 不通过任何 postMessage 或 CustomEvent 中转
- **AND** CM6 的 Undo/Redo 历史栈正常记录,Ctrl+Z 可撤销插入

### Requirement: Blob URL Worker + 主线程降级

The system SHALL attempt to spawn a Web Worker via `URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}))` for heavy computations (DDL parsing, completion candidate building, diagnostics). If Worker construction throws `SecurityError` or Worker fails to post a ready message within 500ms, the system SHALL fall back to executing these computations synchronously on the main thread.

#### Scenario: Worker 创建成功
- **WHEN** snippet 启动并尝试创建 Blob URL Worker
- **AND** pgAdmin CSP 允许 `worker-src blob:` 或未设置 CSP
- **THEN** Worker 创建成功并响应 `ping` 探测
- **AND** 后续 DDL 解析、补全、诊断请求通过 `postMessage` 发往 Worker
- **AND** 主线程不被阻塞,键入响应 < 50ms

#### Scenario: CSP 拦截 Worker 自动降级
- **WHEN** pgAdmin CSP `worker-src` 不允许 `blob:`,Worker 构造抛 `SecurityError`
- **THEN** snippet 捕获异常,记录 `[pg4] worker blocked by CSP, falling back to main thread`
- **AND** 后续 DDL 解析、补全、诊断改为本地模块同步执行
- **AND** 中小 schema(<500 表)下补全 P95 ≤ 50ms 仍可达
- **AND** 大型 schema(2000 表)导入时主线程卡顿 1-3 秒(可接受)

#### Scenario: Worker 探测超时降级
- **WHEN** Worker 创建成功但 500ms 内未响应 `ping`
- **THEN** snippet 视为 Worker 不可用,执行主线程降级
- **AND** 终止已创建的 Worker 实例

### Requirement: IndexedDB 快照持久化

The system SHALL persist DDL snapshots in IndexedDB under the pgAdmin page origin. Database name SHALL be `pg4-smart-assist`. Object stores SHALL include `snapshots` (raw DDL + meta), `schemaGraphs` (parsed graph + search index), `usage` (frequency + lastUsedAt), `queryHistory`. The system SHALL NOT create `hostBindings` store (Snippet runs in single origin, active snapshot stored in `localStorage`).

#### Scenario: DDL 导入持久化
- **WHEN** 用户在浮动抽屉选择 DDL 文件并点击「导入」
- **THEN** snippet 读取文件文本
- **AND** 调用 `parseDdl()` 在 Worker(或主线程)解析为 SchemaGraph
- **AND** 调用 `buildIndex()` 构建搜索索引
- **AND** 写入 `snapshots` 和 `schemaGraphs` 两个 store
- **AND** 控制台输出 `[pg4] snapshot imported: <name>, N schemas, M relations, K warnings`
- **AND** 抽屉显示导入成功与 warning 数量

#### Scenario: 刷新页面后自动加载
- **GIVEN** IndexedDB 中已存在快照,`localStorage["pg4.activeSnapshotId"]` 已设置
- **WHEN** 用户刷新 pgAdmin 页面并重新运行 snippet
- **THEN** snippet 启动时从 IndexedDB 读取活跃快照的 SchemaGraph
- **AND** 加载到内存 `activeGraph`
- **AND** 补全/hover/诊断立即可用
- **AND** 不需要重新导入 DDL 文件

#### Scenario: 快照删除
- **WHEN** 用户在抽屉点击某快照的「删除」按钮并确认
- **THEN** snippet 从 `snapshots`、`schemaGraphs`、`usage` 三个 store 删除该快照的所有记录
- **AND** 若被删快照是当前活跃快照,清空 `localStorage["pg4.activeSnapshotId"]` 并卸载 `activeGraph`
- **AND** 抽屉的快照列表实时刷新

### Requirement: 最小化 UI(单一浮动按钮 + 抽屉)

The system SHALL inject a single floating button at the bottom-right corner of the page (`position: fixed; z-index: 2147483647; pointer-events: auto`). Clicking the button SHALL open a Shadow DOM drawer panel with exactly three sections: "Import Snapshot", "Switch Active Snapshot", "Delete Snapshot". All other settings SHALL be hardcoded in a `CONFIG` constant at the top of the snippet.

#### Scenario: 浮动按钮注入
- **WHEN** snippet 启动成功
- **THEN** 页面右下角出现一个齿轮图标按钮(48x48 px,半透明,hover 不透明)
- **AND** 按钮使用 Shadow DOM 隔离样式,不被 pgAdmin CSS 影响
- **AND** 按钮跟随 pgAdmin 明暗主题

#### Scenario: 抽屉展开
- **WHEN** 用户点击浮动按钮
- **THEN** 右下角展开抽屉面板(宽 360px,高自适应,最大 80vh,可滚动)
- **AND** 抽屉包含三个分区:导入 / 切换 / 删除
- **AND** 切换分区显示已有快照列表 + radio 选择当前活跃快照
- **AND** 删除分区显示已有快照列表 + 每行「删除」按钮
- **AND** 再次点击浮动按钮或按 Escape 关闭抽屉

#### Scenario: 导入分区交互
- **WHEN** 用户在抽屉「导入」分区点击「选择文件」
- **THEN** 触发 `<input type="file" accept=".sql,.txt,.ddl">`
- **AND** 用户选择文件后,名称输入框自动填充文件名(去后缀)
- **AND** 用户可修改名称后点击「导入」按钮
- **AND** 导入期间按钮显示「导入中...」并禁用,完成后显示结果

#### Scenario: 拖拽导入支持
- **WHEN** 用户把 DDL 文件直接拖到抽屉「导入」分区
- **THEN** 阻止默认拖拽行为,显示「释放以导入 <filename>」提示
- **AND** 用户释放后自动读取文件并填充名称输入框

### Requirement: 配置硬编码 CONFIG 常量

The system SHALL expose all tunable settings as a `CONFIG` constant at the top of the snippet. Settings SHALL include at minimum: `runMode`, `completionTriggerMode`, `pasteMode`, `diagnosticsEnabled`, `dangerInterceptEnabled`, `maxCandidates`, `completionShortcut`, `historyRetentionDays`, `showSystemTables`. Changes to settings SHALL require editing the snippet source and re-running.

#### Scenario: CONFIG 结构
- **WHEN** 用户打开 snippet 源码顶部
- **THEN** 看到 `const CONFIG = { ... }` 块,包含所有可调参数及注释说明
- **AND** 每个参数有默认值,用户可改后重新运行 snippet 生效

#### Scenario: 配置变更生效
- **WHEN** 用户修改 CONFIG 中 `diagnosticsEnabled = false` 并重新运行 snippet
- **THEN** 诊断 overlay 不再渲染
- **AND** 补全/hover/危险拦截等其他功能不受影响

### Requirement: 自动重载活跃快照

The system SHALL, on snippet startup, read `localStorage["pg4.activeSnapshotId"]`. If set, the system SHALL load the corresponding SchemaGraph from IndexedDB into memory as `activeGraph`, enabling completion/hover/diagnostics immediately without user action.

#### Scenario: 启动时已有活跃快照
- **GIVEN** IndexedDB 有快照 `snap-abc`,`localStorage["pg4.activeSnapshotId"] = "snap-abc"`
- **WHEN** snippet 启动
- **THEN** 从 IndexedDB 读取该快照的 SchemaGraph
- **AND** 加载到 `activeGraph`
- **AND** 控制台输出 `[pg4] active snapshot loaded: <displayName>, N schemas, M relations`
- **AND** 补全/hover/诊断立即可用

#### Scenario: 启动时无活跃快照
- **WHEN** snippet 启动时 `localStorage["pg4.activeSnapshotId"]` 未设置或对应快照不存在
- **THEN** `activeGraph` 为 null
- **AND** 补全仍提供关键词/内置函数候选(基于上下文,无 schema 信息)
- **AND** hover 与类型诊断不工作(无 schema)
- **AND** 控制台输出 `[pg4] no active snapshot, completion limited to keywords`

### Requirement: MutationObserver 多编辑器接管

The system SHALL, after initial editor discovery, register a `MutationObserver` on `document.documentElement` to detect new `.cm-editor` elements appearing in the DOM (e.g., user opens a new Query Tool tab). Each new editor SHALL be discovered, adopted, and tracked with a stable `editorId`.

#### Scenario: 新 Query Tool tab 接管
- **GIVEN** snippet 已运行,首个 Query Tool 已被接管
- **WHEN** 用户在 pgAdmin 中打开第二个 Query Tool
- **THEN** MutationObserver 检测到新 `.cm-editor` 元素
- **AND** snippet 自动发现并接管该编辑器,分配新 `editorId`
- **AND** 控制台输出 `[pg4] editor adopted cm-<newId>`
- **AND** 新编辑器的补全/诊断/hover 立即可用

#### Scenario: 编辑器关闭清理
- **WHEN** 用户关闭某 Query Tool tab,对应 `.cm-editor` 元素从 DOM 移除
- **THEN** snippet 检测到 DOM 移除,清理该编辑器的会话状态(菜单/诊断/hover)
- **AND** 不影响其他活跃编辑器

### Requirement: 跨 tab 配置同步(storage 事件)

The system SHALL listen to the `window` `storage` event. When `localStorage["pg4.activeSnapshotId"]` changes in another tab, the system SHALL reload the active snapshot. This enables switching snapshot in one tab and having all other pgAdmin tabs follow.

#### Scenario: 跨 tab 活跃快照切换
- **GIVEN** 用户在两个 pgAdmin tab 都运行了 snippet,共享同一活跃快照 A
- **WHEN** 用户在 tab 1 的抽屉中切换活跃快照为 B
- **THEN** tab 1 立即加载快照 B
- **AND** tab 2 接收 `storage` 事件,自动加载快照 B
- **AND** 两个 tab 的补全候选都基于快照 B

#### Scenario: 跨 tab 配置变更
- **WHEN** 用户在 tab 1 修改 CONFIG 并重新运行 snippet
- **THEN** 不影响 tab 2(CONFIG 变更不同步,因 CONFIG 是源码常量)
- **AND** 仅 `localStorage` 中的活跃快照 id 跨 tab 同步

### Requirement: Local Overrides 兼容预留

The system SHALL detect whether it is running in Snippet mode (manual run) or Local Overrides mode (auto-injected by page load). In Local Overrides mode, the system SHALL skip the "user must re-run after refresh" limitation by auto-initializing on page load. The detection SHALL be based on a `CONFIG.runMode` field (`"snippet"` | `"overrides"`), defaulting to `"snippet"`.

#### Scenario: Local Overrides 自动注入
- **GIVEN** 用户已配置 DevTools Local Overrides,在 pgAdmin 某 JS 文件末尾追加 snippet 代码,并设置 `CONFIG.runMode = "overrides"`
- **WHEN** 用户刷新 pgAdmin 页面
- **THEN** snippet 随 pgAdmin JS 加载自动执行
- **AND** 无需用户手动运行
- **AND** 行为与 Snippet 模式一致(补全/诊断/hover/危险拦截/快照管理)

### Requirement: 静默降级

The system SHALL, on any internal error (editor discovery failure, Worker creation failure, parse error, dispatch error), log to console with `[pg4]` prefix and continue operating with degraded functionality. The system SHALL NEVER throw uncaught exceptions that could break pgAdmin native behavior.

#### Scenario: 任意错误降级
- **WHEN** snippet 内部任意模块抛出异常
- **THEN** 错误被顶层 try/catch 捕获
- **AND** 控制台输出 `[pg4] error: <message>`
- **AND** pgAdmin 原生编辑、执行、结果渲染不受影响
- **AND** snippet 后续功能(其他编辑器/其他操作)继续可用

## MODIFIED Requirements

### Requirement: CM6 编辑器发现(从原 SPED §4.1 修改)

原 SPED 规定通过 content_scripts MAIN world 注入 + postMessage 转发。新方案改为 snippet 在 MAIN world 直接执行发现逻辑,持有 view 实例,无需任何跨 world 通信。`QueryEditorAdapter` 接口仍保留,但实现层直接调用 view 方法。

### Requirement: 编辑器写入(从原 SPED §4.2 修改)

原 SPED 规定写入必须通过 bridge `apply-completion` 消息。新方案改为直接 `view.dispatch()`,但保留 `userEvent: "input"` 标记以维持 Undo/Redo 历史栈。仍禁止直接写 `contenteditable.innerText` 或 DOM 节点。

### Requirement: 补全交互编排(从原 SPED §6.6 修改)

原 SPED 规定 content-script 编排 + Worker RPC 双向通信。新方案改为本地模块直接调用,Worker 仅作为计算 offload(若可用)。补全触发、debounce、菜单生命周期、候选应用全部在主线程本地模块完成。

### Requirement: 危险语句拦截(从原 SPED §9.3 修改)

原 SPED 规定扩展层 capture-phase click 监听 + DangerDialog。新方案保留全部交互逻辑,仅把监听层从扩展改为页面级 `document.addEventListener("click", handler, true)`。EXPLAIN 预估仍通过受控 dispatch 改写编辑器 SQL 后让用户点击执行按钮。

### Requirement: 快照生命周期管理(从原 SPED §5.1 修改)

原 SPED 规定 Options 页表单导入。新方案改为页面内浮动抽屉导入,但保留:解析失败不覆盖原有快照、删除前提示、导入时显示 warning、原始 DDL 与 SchemaGraph 绑定到不可变 `snapshotId` 等核心约束。

## REMOVED Requirements

### Requirement: Service Worker / Background

**Reason**: Snippet 无后台进程,所有存储与编排均在页面内完成。
**Migration**: `chrome.runtime.sendMessage` 调用全部改为本地 IndexedDB 函数直接调用;`chrome.storage.local` 改为 `localStorage`;service worker 的内存缓存改为 snippet 内存变量。

### Requirement: Bridge postMessage + nonce 协议

**Reason**: Snippet 在单一 MAIN world 运行,直接持有 view 实例,无需跨 world 通信。
**Migration**: `main-world-bridge.ts` 整个废弃;`messages.ts` 整个废弃;content-script 与 bridge 的所有 postMessage 调用改为本地函数调用。

### Requirement: `chrome.storage.local` / `chrome.runtime.sendMessage`

**Reason**: Snippet 无法访问 chrome.* API。
**Migration**: 配置 → `localStorage`(所有 key 加 `pg4.` 前缀);消息总线 → 本地函数调用;跨 tab 广播 → `storage` 事件。

### Requirement: 跨 tab `chrome.runtime.sendMessage` 广播

**Reason**: 无扩展 API。
**Migration**: 同源 tab 间的活跃快照切换通过 `localStorage` + `storage` 事件自动同步;不同源 tab 之间无同步需求(每个 pgAdmin 站点独立)。

### Requirement: Options 页 / Popup

**Reason**: 无扩展 UI 入口。
**Migration**: Options 页所有功能(快照管理、Host 绑定、设置、片段、历史、数据统计)中,仅快照管理保留并迁移到页面内浮动抽屉;Host 绑定废弃(单 origin);设置迁移到 CONFIG 常量;片段库废弃;历史检索面板废弃;数据统计废弃。

### Requirement: 片段库

**Reason**: 用户决定砍掉,片段直接用 DevTools Snippets 自身管理(用户可在 Snippets 中新建多个片段作为 SQL 片段库)。
**Migration**: 无。

### Requirement: 查询历史检索面板

**Reason**: pgAdmin 自带查询历史;且为了砍 UI 复杂度。
**Migration**: 仍保留「执行时记录 SQL 到 IndexedDB」的写入逻辑(便于后续恢复 UI),仅去掉检索 UI。

### Requirement: JSONB 结果区域复制

**Reason**: P1 功能,但依赖 pgAdmin 结果 grid 探针,本次 MVP 不做。
**Migration**: 无,后续可追加。

### Requirement: DDL 快照 Diff 视图

**Reason**: P2 功能,本次 MVP 不做。
**Migration**: `snapshot-diff` 算法可保留实现,但不暴露 UI。

### Requirement: JSONB 结构树预览

**Reason**: P2 功能,本次 MVP 不做。
**Migration**: JSONB 路径补全仍保留(P0 范围),仅去掉树形预览 UI。
