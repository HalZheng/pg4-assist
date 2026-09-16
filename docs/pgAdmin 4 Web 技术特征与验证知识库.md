# pgAdmin 4 Web 技术特征与验证知识库

本文件是 [`pg4-assist.js`](../pg4-assist.js)（v2）的实现依据与排查手册，持续记录 pgAdmin 4 Web 的页面结构、编辑器集成边界、可观测接口和增强功能验证方法。新增事实时应优先记录观察条件、证据和对实现的影响，避免把单一部署环境的偶然行为当成 pgAdmin 4 的通用特征。

历史验证记录（§12 起）产生于 v1（`pg4-snippet.js`，已归档至 `legacy/snippet-v1/`）时代，保留作原始证据；其中的结论（标识符引号语义、EF Core 适配、closeBrackets 配对）已由 v2 继承实现。

## 1. 访问入口和前置条件

验证入口可以是本地部署、内网部署、容器转发或其他可访问的 pgAdmin 4 URL：

```text
https://<pgadmin-host>/browser/
```

访问链路如下：

```text
浏览器自动化或人工浏览器
    ↓
部署入口、反向代理或端口转发
    ↓
部署层认证（可能不存在）
    ↓
pgAdmin 登录
    ↓
pgAdmin Browser
    ↓
Query Tool iframe
    ↓
CodeMirror 6 editor
```

开始前确认：

1. 浏览器可以访问目标 pgAdmin 4 URL；若存在外部认证，先完成认证。
2. pgAdmin 已配置并登录。
3. 至少有一个可用的 Query Tool 标签。
4. 工作区已备好 DDL 快照数据（如 Pagila schema，可参考
   [GitHub Codespaces 部署指南](./GitHub%20Codespaces%20%E9%83%A8%E7%BD%B2%20PostgreSQL%20+%20pgAdmin%204%20+%20Pagila%20%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97.md)
   搭建环境）。

不同部署环境的认证、代理、端口转发和后端连接异常应单独记录，不要写入依赖特定环境的实现逻辑。

## 2. 已确认的页面技术特征

以下事实在 pgAdmin 9.10（`app_version_int = 91000`）与 9.17（Codespace docker 部署）实测确认，是 v2 实现的直接依据。

### 2.1 Query Tool 位于同源 iframe

1. Query Tool 位于**同源 iframe** `/sqleditor/panel/<id>`，顶层文档里 `.cm-editor` 数量为 **0**。
2. 外层 `DIV` 与 `IFRAME` **共用同一个 `id`** `id-query-tool_<n>`，
   `getElementById` 返回的是 DIV —— 必须用 `querySelectorAll('iframe')`。
3. 跨源 frame 访问 `contentWindow.location` 会抛异常，用 try/catch 做**同源判断 + 安全取 contentWindow**。
4. pgAdmin 的标签页是懒加载的，新开 Query Tool 会晚一些出现；iframe 重新导航后需重新接管
   （v2 用 MutationObserver + 4 秒轮询 + frame load 事件兜底）。

### 2.2 编辑器是 CodeMirror 6

1. Query Tool 的编辑区表现为 CodeMirror 6 DOM，可以 `.cm-editor` / `.cm-content` 作初步探测条件。
2. `cmView` 挂在 **`.cm-content`** 上，不是 `.cm-editor`。
3. pgAdmin 打包经 Webpack 混淆，不能依赖开发环境中的模块名或未混淆属性名。
4. pgAdmin 的「查询历史」面板也是一个 CM6 实例，但 `state.readOnly === true`，增强时必须跳过。

### 2.3 模块获取：webpack 运行时挖掘

1. 取真 `__webpack_require__` 只能走
   `webpackChunk.push([[id], { [id]: () => {} }, (r) => ...])` 的**第三个回调参数**。
   **不能**自己重放 module factory —— 那会得到 CodeMirror 模块的副本，facet 身份不一致，
   注册的扩展不生效。
2. 模块是 CommonJS 风格（`t.EditorView = ...`）且**导出名未混淆**，扫描
   `String(req.m[id]).includes('.StateEffect=')` 之类的标记即可定位；14428 个模块耗时约 **85 ms**。
   标记集：`.StateEffect=`（state）、`.hoverTooltip=`（view）、`.autocompletion=`（autocomplete）、
   `.syntaxTree=`（language）、`.PostgreSQL=`（sql）。
3. 每个包有两份（另一份被混淆），用 `view.state instanceof exp.EditorState`、
   `view instanceof exp.EditorView` 之类的**身份校验**挑对的那份。

### 2.4 补全接管边界

1. **不能** `appendConfig(autocompletion({ override: [...] }))` —— 该版本 `completionConfig`
   对 `override` 没有 combiner，会抛 `Config merge conflict for field override`。
   做法是**就地替换已解析配置里的 `override[0]`**（该数组引用与 pgAdmin 传入的 config 共享，
   facet 重算后依然生效）。
2. 同理 `activateOnTyping` 等 pgAdmin 已设置的键都不能再传，**自动触发得自己实现**
   （updateListener 监听 `input.type` 用户事件 + `startCompletion`）。
3. 取 `completionConfig` 这个 Facet 的方法：把 `autocompletion({ activateOnTyping: true })`
   返回的扩展数组拍平，带 `.facet` 且 value 含 `activateOnTyping` 的那一项就是。

### 2.5 扩展挂载与写入

1. `StateEffect.appendConfig` **不可撤销**。脚本重复运行时若每次都 append，
   旧实例的 `hoverTooltip` / `updateListener` 会永远留在配置里并排在前面（表现为「悬停显示过期内容」）。
   v2 的做法：每个 `EditorView` 只挂一次扩展（`view.__pg4Slot`），全部通过 `slot.session`
   读取「当前生效的会话」。
2. 写入必须使用 `view.dispatch({ changes, selection, userEvent })`，不要直接改写编辑器 DOM——
   直接改 DOM 会绕过 CodeMirror 的状态、选择区、Undo/Redo 和扩展事件链。
3. 本站没有打包 `@codemirror/lint`，诊断是自己用 `StateField` + `Decoration.mark` +
   `hoverTooltip` 实现的。

### 2.6 可观测接口

1. pgAdmin 执行 SQL 后会向 `/sqleditor/query_history/` 发 XHR POST（JSON body 含
   `query` / `start_time` / `total_time` / `row_affected` / `status` / `message`，
   自身面板查询带 `is_pgadmin_query` 标记）。包装 `XMLHttpRequest.prototype.open/send`
   可**观察**（不拦截）所有执行路径，用于离线查询历史。
2. Query Tool iframe URL 带有 `database_name` 查询参数，可解析作库名。

### 2.7 已知 pgAdmin 自身行为 / bug

1. CM6 `closeBrackets` 生效：输入前导 `"` 自动补闭合引号，光标停在两引号之间。
   补全 `insertText` 若自带引号对会与残留闭合引号叠加（`""Name""`）——
   应用候选时必须吞掉光标右侧已打的右引号。
2. 任何粘贴都会在控制台抛 `TypeError: (0, n.hasTrojanSource) is not a function`。
   这是 pgAdmin 9.10 自身 bug，与增强脚本无关。

### 2.8 页面内容和页面对象都应视为不稳定边界

SQL 文本、DOM 属性、Webpack 模块和 pgAdmin 内部对象都可能随版本变化。增强功能应：

1. 先探测能力，再启用功能。
2. 对找不到编辑器、模块或 UI 容器的情况静默降级。
3. 不依赖固定的 Webpack chunk 编号、内部变量名或单一 CSS 层级。
4. 把版本、URL、frame URL 和控制台证据记录在验证结果中。

## 3. 运行形态与注入

v2 是单文件脚本，**在顶层页面运行即可**（不需要切到 Query Tool iframe 上下文）：
顶层实例自己扫描并接管所有同源 iframe 里的编辑器。

三种运行形态（同一份文件自适应）：

1. DevTools → Sources → Snippets → 粘贴全文 → Ctrl+Enter（顶层页面上下文）。
2. Tampermonkey / 用户脚本：`@match https://<host>/*` 且允许所有 frame——
   脚本自带 frame 协调逻辑，子 frame 实例发现顶层（同源）已在管会自动退让。
3. DevTools Local Overrides 挂到 pgAdmin 某个静态 JS 上自动注入。

幂等性：重复运行提示「已在运行，跳过」。需要重载最新代码时先执行
`window.__pg4.destroy()`（等价 `window.__pg4Assist.destroy()`）再注入。

浏览器自动化注入推荐本地文件方式，不要把 130KB 左右的源码拼进 `evaluate` 参数：

```javascript
await page.addScriptTag({ path: 'pg4-assist.js' }); // 顶层 frame
```

等待约 1.5 秒后检查启动状态（见 §4）。

## 4. 调试与自动化入口

```javascript
window.__pg4Assist               // Core 实例
window.__pg4Assist.sessions      // Map<sessionId, EditorSession>，接管中的编辑器
window.__pg4Assist.graph         // 当前激活的 schema graph（无快照时为 null）
window.__pg4Assist.snapshotMeta  // 当前快照元信息

window.__pg4                     // 调试 API
window.__pg4.version             // "2.0.0"
window.__pg4.config              // 当前配置
window.__pg4.setConfig(patch)
window.__pg4.importDdlText(text, name, fileName)
window.__pg4.attachAll()         // 手动重扫编辑器
window.__pg4.destroy()
// 纯函数（可脱离编辑器直接跑）：
window.__pg4.analyzeContext(sql, pos, graph)
window.__pg4.buildCandidates(info, graph, usageMap)
window.__pg4.runDiagnostics(sql, graph)
window.__pg4.transformPaste(clip, docText, pos)
window.__pg4.tokenize / parseDdl / buildIndex
```

成功标准：

```text
window.__pg4Assist.sessions.size >= 1
window.__pg4Assist.graph 非空（已导入快照）
```

控制台应出现 `PG4 Assist v2.0.0 已启动 · 接管 N 个编辑器`。

## 5. 导入 DDL 快照

验证 schema 功能时，优先调用公开的调试句柄，避免依赖面板的文件选择器：

```javascript
const result = await page.evaluate(async ddlText => {
  return window.__pg4.importDdlText(ddlText, 'pagila', 'pagila-schema.sql');
}, ddl);
```

成功结果应包含：

```text
meta.name = pagila
meta.stats.schemaCount >= 1
meta.stats.relationCount > 0
warnings.length = 0 或者已明确记录
window.__pg4Assist.snapshotId 非空
window.__pg4Assist.graph 非空
```

快照持久化到 IndexedDB（`pg4-assist` 库），脚本下次运行自动恢复，无需重复导入。

## 6. 功能验证矩阵

每次修改编辑器接管、解析、补全、诊断或 UI 代码后，至少执行以下矩阵。
v2 的补全菜单是 **CM6 原生补全弹层**（`cm-tooltip-autocomplete`），不是自建 DOM。

| 功能 | 输入/动作 | 通过标准 |
|---|---|---|
| 表名补全 | `SELECT * FROM ac` | CM6 菜单候选包含 `actor` |
| 智能引号（EF Core） | `SELECT * FROM useri` | 菜单 `UserInfo→"UserInfo"`，应用后文档为 `SELECT * FROM "UserInfo"`（自动引号、public 表无 schema 前缀） |
| 限定列补全 | `SELECT a. FROM actor a` | 候选包含 `actor_id`、`first_name` |
| schema 补全 | `SELECT * FROM public.ac` | 候选包含 `actor` |
| INSERT 列补全 | `INSERT INTO actor (fi` | 候选包含 `first_name` |
| JOIN 条件推断 | `JOIN x ON` | 候选给出连接条件（显式 FK 优先，命名约定次之） |
| 未知列诊断 | `SELECT a.nope FROM actor a` | 波浪下划线 + 悬停显示 does not exist |
| 引号缺失诊断 | 裸名引用折叠库中不存在的带引号对象 | 出现大小写/引号相关诊断 |
| 悬停文档 | 悬停 `actor` 表名 | 显示 `public.actor`、kind 和列数 |
| 智能粘贴 | 在 `WHERE first_name = ` 后粘贴 `Penelope` | 文档变为 `... = 'Penelope'` |
| 查询历史 | 执行一条 SQL | 面板「历史」页出现记录（SQL、库名、耗时） |
| 使用频次 | 采纳某候选多次 | 该候选排序提前 |

算法层断言可以不碰编辑器，直接跑纯函数：

```javascript
const graph = window.__pg4Assist.graph;
const info = window.__pg4.analyzeContext('SELECT * FROM useri', 18, graph);
const cands = window.__pg4.buildCandidates(info, graph, new Map());
// 断言 cands 中含 insertText 为 '"UserInfo"' 的候选
```

## 7. 输入事件注意事项

1. v2 的自动补全触发挂在 CM6 `updateListener` 上：要求事务带
   `userEvent: 'input.type'` 且光标前是 `.` / `"` 或满足最少字符数。
   因此程序化 `view.dispatch({ changes, userEvent: 'input.type' })` **可以**触发自动补全；
   不带 `input.type` 的 dispatch 只会触发诊断（诊断只看 `docChanged`）。
2. JS 派发 `KeyboardEvent('keydown')` 不会走 CM keymap，不能用 JS 键盘事件模拟 Enter
   提交候选；必须真实键盘或 CM6 事务。
3. 等待时间建议：

```text
补全：至少 400 ms（含 90 ms debounce）
诊断：至少 600 ms（400 ms debounce）
悬停：至少 450 ms（300 ms hoverTime）
```

## 8. 故障分流

### 跳转外部认证或登录页

这是部署入口的认证行为，不应归因于脚本。完成外部认证和 pgAdmin 登录后，再继续。

### 页面显示但接口大量 500

先执行一次页面 reload。反向代理、容器或 pgAdmin 后端重启期间可能出现短暂 500；
不要立即把它归因于脚本。

### `sessions.size = 0`

按顺序检查：

1. Query Tool 是否已打开（不是只打开 pgAdmin 主界面）。
2. 注入是否发生在**顶层页面**（v2 自己会深入同源 iframe；不要注到别的 iframe 里单干）。
3. Query Tool 是否仍处于加载阶段（v2 每 4 秒轮询重扫，可稍等或手动
   `window.__pg4.attachAll()`）。
4. 控制台是否有 `CodeMirror 模块定位失败`（webpack 挖掘失败，检查 §2.3 各条）。
5. 目标是否为只读面板（查询历史面板 `readOnly === true`，按设计跳过）。
6. 控制台是否有 `adopted editor` / `接管编辑器失败` 日志。

### 快照未生效

`window.__pg4Assist.graph` 为 null：检查 IndexedDB（`pg4-assist` 库）里是否有快照、
`window.__pg4.config.activeSnapshotId` 是否指向存在的快照。

### 后端连接断开

脚本的解析、补全、诊断和快照读取全在浏览器端运行。后端连接断开时，可以继续验证这些
离线功能；涉及真正执行 SQL 的路径应标记为未完成，而不是伪造通过。

## 9. 验证结果记录格式

每次修改后，在任务结果中记录以下内容：

```text
站点：<pgAdmin URL>
Query Tool frame：<frame URL>
脚本：pg4-assist.js <版本或 git commit>
Editor：接管数量 / adopted
Snapshot：<name>, <schema count> schemas, <relation count> relations, <warning count> warnings
功能矩阵：通过数量 / 总数量
发现的问题：<实际问题>
修复内容：<文件和行为变化>
回归测试：<命令和结果>
环境异常：<500、断连、登录等待等>
```

## 10. 验证分工

v1 时代的 `headless.mjs` / `smoke.html` 已随 v1 归档（`legacy/snippet-v1/`）。
v2 的验证分两层：

```text
算法层（任意页面控制台即可）
    → window.__pg4 的纯函数：analyzeContext / buildCandidates /
      runDiagnostics / transformPaste / parseDdl

真实 pgAdmin 站点
    → iframe 结构、webpack 模块挖掘、override[0] 就地替换、
      CM6 原生菜单端到端、查询历史观察、面板 UI
```

真实站点测试不能替代算法层测试；它用于确认集成边界和用户可见行为。

## 11. 增量记录新技术事实

后续发现 pgAdmin 4 的新页面结构或运行时行为时，按以下格式追加记录：

```text
发现日期：YYYY-MM-DD
pgAdmin 版本或构建：<可见版本、部署信息或未知>
页面/功能：<例如 Query Tool、对象浏览器、结果面板>
观察条件：<URL、frame、操作步骤和前置状态>
观察结果：<DOM、事件、对象或控制台证据>
对增强功能的影响：<可利用的接口、兼容性风险或降级策略>
验证方式：<手工步骤、纯函数断言或真实站点>
```

记录技术事实时区分三类结论：

1. **稳定事实**：多个版本或多个部署环境均观察到的行为，可作为实现依据。
2. **当前构建事实**：只在某个 pgAdmin 构建中确认，必须附版本或证据，不能直接泛化。
3. **待验证假设**：由页面结构或错误日志推测，不能作为功能通过标准。

---

## 12. 历史验证记录（v1 时代）

> 以下记录产生于 v1（`pg4-snippet.js`，自建 Shadow DOM UI 版本），保留原始证据与结论。
> 标识符引号语义、EF Core 适配、closeBrackets 配对处理等结论由 v2 继承。

### 12.1 验证记录：2026-08-22（标识符引号感知 + EF Core 适配迭代）

```text
站点：https://upgraded-fishstick-qvjxw74p75r399rj-5050.app.github.dev/browser/
Query Tool frame：id-query-tool_*.iframe（同源，主文档可经 iframe.contentWindow 直接操作）
脚本：pg4-snippet.js（本地 serve.py :8765 提供，本轮多次迭代）
Worker：main-thread fallback（站点 CSP 阻止 blob Worker，行为符合设计降级）
Editor：adopted（editors=1~3，isConnected=true）
Snapshot：pagila（1 schema / 44 relations）；efcore / ef2（EF Core 风格 DDL 验证用）
功能矩阵：headless 114/114 通过；真实站点算法层全过、真实键盘端到端（无引号场景）通过
发现的问题：
  1. DDL 中未引号创建的混合大小写标识符（如 SalesReport）实际存储为小写折叠形式，
     旧版 insertText 用源拼写会引用不存在的对象。
  2. 带引号 schema（"Reporting".）后无法列出表：activeSchema 强制小写折叠导致键查找失败。
  3. pgAdmin 的 CM6 closeBrackets 会在输入前导双引号时自动补闭合引号；
     旧版补全 insertText 自带引号对会与残留闭合引号叠加（""UserInfo"" 双引号重复）。
  4. 浏览器 HTTP 缓存会缓存 serve.py 的 snippet 响应，重注入可能拿到旧版
     （用 fetch(..., {cache:'no-store'}) + 重置激活标志解决）。
修复内容（pg4-snippet.js）：
  - 新增 RESERVED_KEYWORDS / identNeedsQuote / quoteIdent / identInsert / effName：
    按需双引号（含大写/特殊字符/前导数字/保留字冲突才加引号），未引号 DDL 名按 PG
    折叠语义取有效名；EF Core 默认命名（PascalCase 全引号 DDL）下所有表列自动带引号。
  - generateCandidates 全部标识符候选 insertText 走 identText（引号感知 + 有效名）；
    限定名各部分独立判断（"Reporting".salesreport）。
  - buildCompletionContext 新增 closeBrackets 配对检测（wordQuotedPair）：光标两侧
    紧邻引号对时替换范围吞掉双引号 [from-1, to+1)，insertText 统一完整引号形式，
    杜绝双引号重复；classifyCursor 内层引号回退跳过配对场景避免抢跑。
  - schema-relation 修复：activeSchemaQuoted 标志贯穿，带引号 schema 按原样查键。
  - rankCandidates / 智能粘贴 identifier 槽复用同一套引号规则。
回归测试：node legacy/snippet-v1/test/headless.mjs → 114/114 通过
  （新增 [4b] PG 大小写语义 21 项、[4c] EF Core 默认命名 + closeBrackets 配对 20 项）
环境异常：Codespace 30 分钟无活动休眠导致站点白屏（重启 Codespace + docker compose up -d
  恢复）；VS Code web 的 xterm.js 终端无法自动化输入（容器启动需人工执行）。
```

#### 新技术事实（2026-08-22）

```text
pgAdmin 版本或构建：pgAdmin 4 v9.17（Codespace docker 部署）
页面/功能：Query Tool 编辑器（CM6）
观察条件：Query Tool iframe 内 evaluate；真实键盘逐字输入 SELECT * FROM "act
观察结果：
  1. CM6 closeBrackets 生效：输入前导 " 自动补闭合引号，光标停在两引号之间
     （文档为 "act"，光标在末引号前）。
  2. 真实键盘 Enter 经 CodeMirror keymap 正确路由到补全提交处理；
     JS 派发 KeyboardEvent('keydown') 不会走 CM keymap，不能用于模拟 Enter 提交。
对增强功能的影响：补全引擎必须同时处理三种引号上下文——裸前缀（act）、未闭合引号
  （"act 无闭合）、closeBrackets 配对（"act" 光标在中间），三者 from/to/insertText
  组合各不相同；配对场景若不吞掉双侧引号会产生双引号重复。
验证方式：headless [4b]/[4c]（114/114）+ 真实站点算法层验证（清缓存重注入后
  from=14/to=21/insertText='"UserInfo"'/appliedOk=true）
```

### 12.2 验证记录：2026-08-23（EF Core 端到端：补全产物真实执行对照）

```text
站点：https://upgraded-fishstick-qvjxw74p75r399rj-5050.app.github.dev/browser/
Query Tool frame：id-query-tool_4674990（innerW=963，hasEditor=true）
脚本：pg4-snippet.js（cache:'no-store' 重注入，快照 efcore8）
测试数据：ef schema 三张区分大小写表（真实数据库已建）：
  ef."UserInfo"("UserId","UserName","CreatedAtUtc")
  ef."Order"("OrderId","UserInfoUserId" FK→UserInfo,"TotalAmount")
  ef."__EFMigrationsHistory"("MigrationId")
验证场景与结果：
  场景2 schema-relation 空前缀（SELECT * FROM ef.|）：menuOpen=true，
    items = UserInfo→"UserInfo"、Order→"Order"、
            __EFMigrationsHistory→"__EFMigrationsHistory"（裸表名自动加引号）
  场景3 应用候选：scene3 = SELECT * FROM ef."UserInfo"（appliedIns="UserInfo"）
  真实执行对照（Execute script 按钮）：
    quotedExec：SELECT * FROM ef."UserInfo" LIMIT 3 → Total rows，无 ERROR ✅
    bareExec：  SELECT * FROM ef.UserInfo  LIMIT 3 → relation does not exist ❌（符合预期）
  结论：补全产物带引号 SQL 真实执行成功；裸名真实报错——证明 EF Core 默认命名下
  自动加引号是正确性要求而非风格偏好。
回归测试：node test/headless.mjs → 124/124 通过
```

#### EF Core 真实默认场景（public schema、无前缀）验证：2026-08-23 补充

```text
用户核心需求确认：EF Core 默认（无 snake_case）→ 补全自动加 " " → UserInfo 大小写保留
→ 必须写 "UserInfo" 否则报错。默认 schema 是 public（EF Core 不配置 schema 时
建表落 public），不是自定义 schema。
验证结果（真实站点，快照 efcore-pub = 无 schema 前缀的 EF Core DDL）：
  1. 无前缀小写补全：SELECT * FROM useri
     → menuOpen=true，items 含 UserInfo→"UserInfo"
     （public 表：自动加引号、不带 schema 前缀、大小写保留）
  2. 应用候选：sceneApply = SELECT * FROM "UserInfo"（appliedIns='"UserInfo"'）
  3. 带引号真实执行：SELECT * FROM "UserInfo" LIMIT 3 → 查询成功（Total rows）
行为规则（与代码一致，v2 继承）：
  - 表在 public（EF Core 默认）→ 无前缀补全插入 "UserInfo"（仅引号，无 schema）
  - 用户键入 schema 前缀（ef.）→ 只补表名部分 "UserInfo"，前缀留在文档里
  - 表在非 public schema 且无前缀补全 → 插入限定形式 ef."UserInfo"
    （PG 语义要求：search_path 不含 ef 时裸名/仅引号名都无法解析，必须限定）
重要发现：真实库 public 残留一个折叠小写表 userinfo（早期未引号 DDL 测试产物），
  导致裸名 SELECT * FROM UserInfo 不报错而是【静默解析到错误对象】——比报错更危险。
  这正是按需引号判断存在的理由：裸名折叠语义下，同名折叠表存在时查到的是另一张表的数据。
未完成项（环境故障阻断）：public 场景裸名报错的执行演示。但该语义与 ef 场景
完全一致（§12.2 已真实捕获 relation does not exist），属同一 PG 折叠规则。
```

### 12.3 浏览器自动化操作教训（pgAdmin 站点，2026-08-23 实战总结）

```text
1. 左侧纵向图标栏：永远停留在左上角第一个按钮（Default Workspace，带对象浏览器），
   遇事不决点它。绝对禁止：第二个图标（重新连接）、"Query Tool Workspace" 标签
   （点它会把页面切到无连接空白态，所有 Query Tool iframe 变 0x0）。
2. "保存查询变更？"弹窗随手点"不要保存"。
3. 对象浏览器树节点是 div.file-entry（不是 li），展开箭头为 <i class="directory-toggle">，
   点节点文字不会展开；已展开的 toggle 带 open 类。节点文字在 span.file-name，
   界面为中文（"数据库"而非 Databases）。选中节点：点 .file-label。
4. 打开 Query Tool：选中目标数据库后右键 → "查询工具"。
5. browser_evaluate 返回值可能丢失：用两步法（脚本写 window.__x，再单独 evaluate 读取）。
6. 环境恢复：Codespace 唤醒 → 人工 docker compose up -d → 注入脚本前确认站点可用。
```

### 12.4 pgAdmin 执行与故障教训（2026-08-23 深夜轮）

```text
1. Execute 按钮程序化 .click() 不可靠：约半数点击不触发执行。判别法——连续两次
   读取状态栏（class 含 StatusBar 元素）时长完全相同（如 00:00:00.738 成对出现）
   即为陈旧值；且数据输出面板持续显示"无数据输出。执行查询以获得输出。"占位符。
   可靠方式：用快照元素 ref 真实点击（受信任事件），每次执行后重新快照
   （pgAdmin 执行后重渲染工具栏，ref 会失效）。
2. innerText 是布局感知的：消息面板虚拟化/滚动裁剪后 innerText 拿不到内容。
   要完整文本用 textContent；查询结果标记建议用 RAISE EXCEPTION 'PG4DIAG...'，
   在 textContent 全文搜标记定位。
3. 消息行可能被拆分渲染（叶子元素不含完整标记串），搜标记要对所有元素（含非叶子）
   或直接 body.textContent。
4. "Quit pgAdmin 4" 确认弹窗：必须点取消。误确认/误触发 Quit 流程会杀掉 pgAdmin
   后端 worker——之后前端全部 API 404（"Failed to fetch data"）、Query Tool 卡
   "加载中"、整页刷新也回不到浏览器页（停在 "Let's connect to the server"）。
   恢复只能重启容器：docker compose restart pgadmin（终端无法自动化，需人工）。
5. 状态栏结构：Total rows / 查询完成+时长 / 光标行列，各为独立元素，
   textContent 拼接后形如 "Total rows: § 查询完成 00:00:00.743 § CRLFLF CRLF 行数 1，列数 25"。
```
