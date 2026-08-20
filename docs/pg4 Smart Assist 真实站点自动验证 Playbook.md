# pgAdmin 4 Web 技术特征与增强功能验证知识库

本文件用于持续记录 pgAdmin 4 Web 的页面结构、编辑器集成边界、可观测接口和增强功能验证方法，作为实现和排查 [pg4-snippet.js](../pg4-smart-assist-snippet/pg4-snippet.js) 的项目知识库。新增事实时应优先记录观察条件、证据和对实现的影响，避免把单一部署环境的偶然行为当成 pgAdmin 4 的通用特征。

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
4. 工作区存在 [pagila-schema.sql](../pagila-schema.sql)，或可以准备其他真实 schema 快照。

不同部署环境的认证、代理、端口转发和后端连接异常应单独记录，不要写入依赖特定环境的实现逻辑。

## 2. 已确认的页面技术特征

### 2.1 Query Tool 通常位于 iframe

不要假设 Query Tool 在 `/browser/` 主文档中。pgAdmin 4 通常通过同源 iframe 承载 Query Tool 页面，Query Tool 的 URL 常包含 `sqleditor/panel` 和查询工具相关参数。

### 2.2 编辑器是 CodeMirror 6

Query Tool 的编辑区表现为 CodeMirror 6 DOM，可以用 `.cm-editor` 作为初步探测条件。页面打包可能经过 Webpack 混淆，不能依赖开发环境中的模块名或未混淆属性名。

### 2.3 编辑器实例可能隐藏在页面内部对象中

当前 pgAdmin 构建中，DOM 上不一定存在可直接访问的 `cmView`。增强功能需要通过页面已有的 CodeMirror 6 `EditorView` 能力发现实例，并且写入必须使用：

```javascript
view.dispatch({ changes, selection, userEvent });
```

不要直接改写编辑器 DOM。直接改 DOM 会绕过 CodeMirror 的状态、选择区、Undo/Redo 和扩展事件链。

### 2.4 页面内容和页面对象都应视为不稳定边界

SQL 文本、DOM 属性、Webpack 模块和 pgAdmin 内部对象都可能随版本变化。增强功能应：

1. 先探测能力，再启用功能。
2. 对找不到编辑器、模块或 UI 容器的情况静默降级。
3. 不依赖固定的 Webpack chunk 编号、内部变量名或单一 CSS 层级。
4. 把版本、URL、frame URL 和控制台证据记录在验证结果中。

## 3. 浏览器定位与增强注入边界

schema 下载、代理和认证属于部署环境问题，不是 pgAdmin 4 Web 技术特征；验证记录中应单独注明这些环境条件。

自动化时按以下规则定位 Query Tool：

1. 遍历 `page.frames()`。
2. 对每个 frame 执行 `document.querySelector('.cm-editor')`。
3. 找到包含 `.cm-editor` 的 frame 后，将它作为 `queryFrame`。
4. 后续 snippet 注入、编辑器操作、按钮点击和 UI 检查全部在 `queryFrame` 中执行。

典型 frame 结构：

```text
/browser/
├── /sqleditor/panel/<id>?is_query_tool=true   ← Query Tool
└── /sqleditor/panel/<id>?is_query_tool=false  ← 其他对象面板
```

如果还没有 Query Tool，先在 pgAdmin 中打开数据库的 Query Tool，再重新扫描 frame。

## 4. 注入 snippet

使用浏览器自动化的本地脚本注入能力，不要把 160KB 左右的源码拼接进 `evaluate` 参数。推荐直接使用本地文件注入：

```javascript
await queryFrame.addScriptTag({
  path: 'c:/path/to/pg4-smart-assist-snippet/pg4-snippet.js'
});
```

等待约 1.5 秒后检查：

```javascript
await queryFrame.evaluate(() => ({
  active: window.__pg4Active,
  hasPg4: typeof window.__pg4 === 'object',
  workerAvailable: window.__pg4?.state?.workerAvailable,
  editorsCount: window.__pg4?.state?.editors?.size,
}));
```

成功标准：

```text
active = true
hasPg4 = true
editorsCount >= 1
```

`workerAvailable` 可以是 `true` 或 `false`。Blob Worker 被 CSP 拦截时，snippet 应自动降级到主线程，不应判定为失败。

如果重复注入只得到：

```text
[pg4] snippet: already active, skipping
```

说明页面上的 `window.__pg4Active` 已经存在。只有在需要重新加载最新源码进行验证时，才执行：

```javascript
await queryFrame.evaluate(() => { window.__pg4Active = false; });
```

然后重新注入。不要在正常用户流程中依赖手工重置这个标志。

## 5. 导入 Pagila schema 快照

验证 snippet 的 schema 功能时，优先调用公开的调试句柄，避免依赖 Shadow DOM 文件选择器：

```javascript
const ddl = await /* 读取 pagila-schema.sql */;
const result = await queryFrame.evaluate(async ddlText => {
  return window.__pg4.importSnapshotFromText(
    ddlText,
    'pagila',
    'pagila-schema.sql'
  );
}, ddl);
```

如果自动化框架不能直接把本地文件传入浏览器，可以采用临时 JS 文件注入：

1. 在终端读取 DDL。
2. 转成 base64。
3. 生成临时脚本 `window.__pg4DdlB64 = "..."`。
4. 用 `queryFrame.addScriptTag({ path })` 注入。
5. 在 frame 内执行 `atob(window.__pg4DdlB64)`，再调用 `importSnapshotFromText`。
6. 删除临时脚本，保留 schema 文件。

成功结果应包含：

```text
meta.displayName = pagila
meta.schemaCount >= 1
meta.relationCount > 0
warnings.length = 0 或者已明确记录
state.activeSnapshotId 非空
state.activeGraph 非空
```

本次 Pagila 3.1.0 实测基线是：

```text
1 schema
44 relations
0 warnings
```

## 6. 功能验证矩阵

每次修改 snippet 的编辑器、解析器、补全、诊断或 UI 代码后，至少执行以下矩阵：

| 功能 | 输入/动作 | 通过标准 |
|---|---|---|
| 表名补全 | `SELECT * FROM ac` | 候选包含 `actor` |
| 限定列补全 | `SELECT a. FROM actor a` | 候选包含 `actor_id`、`first_name` |
| schema 补全 | `SELECT * FROM public.ac` | 候选包含 `actor` |
| INSERT 列补全 | `INSERT INTO actor (fi` | 候选包含 `first_name` |
| 未闭合括号诊断 | `SELECT * FROM actor WHERE (first_name = 'x'` | 诊断层有 error 标记 |
| 未知列诊断 | `SELECT a.nope FROM actor a` | 出现 does not exist 诊断 |
| 悬停文档 | 悬停 `actor` 表名 | 显示 `public.actor`、kind 和列数 |
| 危险拦截 | `DELETE FROM actor` 后点击 Execute | 出现危险语句对话框 |
| 安全查询 | `SELECT * FROM actor WHERE actor_id = 1` | 不出现危险对话框 |
| 智能粘贴 | 在 `WHERE first_name = ` 后粘贴 `Penelope` | 文档变为 `... = 'Penelope'` |

## 7. 输入事件注意事项

直接调用 CodeMirror `view.dispatch()` 可以改变文档，但不一定触发 snippet 监听的浏览器 `input` 事件。因此 UI 补全和诊断验证需要在 dispatch 后补发 native input 事件：

```javascript
sess.view.dispatch({
  changes: { from: 0, to: sess.view.state.doc.length, insert: sql },
  selection: { anchor: sql.length },
  userEvent: 'input',
});
sess.el.dispatchEvent(new InputEvent('input', { bubbles: true }));
```

等待时间建议：

```text
补全：至少 400 ms
诊断：至少 600 ms
悬停：至少 450 ms
```

## 8. 故障分流

### 跳转外部认证或登录页

这是部署入口的认证行为，不应归因于 snippet。完成外部认证和 pgAdmin 登录后，再继续扫描 Query Tool frame。

### 页面显示但接口大量 500

先执行一次页面 reload，并重新扫描 Query Tool frame。反向代理、容器或 pgAdmin 后端重启期间可能出现短暂 500；不要立即把它归因于 snippet。

### `editorsCount = 0`

按顺序检查：

1. 当前 frame 是否真的包含 `.cm-editor`。
2. Query Tool 是否仍处于加载阶段。
3. 是否在包含编辑器的 iframe 中注入，而不是 `/browser/` 主 frame。
4. `window.__pg4Active` 是否导致旧实例跳过启动；仅测试重新注入时重置它。
5. 控制台是否出现 `editor adopted` 或 `no CodeMirror 6 editor found`。

### Worker 不可用

如果 `workerAvailable = false`，继续验证主线程路径。只有出现解析、补全或诊断异常时，才把 Worker 单独列为问题。

### 后端连接断开

snippet 的解析、补全、诊断和快照读取主要在浏览器端运行。后端连接断开时，可以继续验证这些离线功能；涉及真正执行 SQL 的危险拦截“继续执行”路径则应标记为未完成，而不是伪造通过。

## 9. 验证结果记录格式

每次自动修复后，在任务结果中记录以下内容：

```text
站点：<pgAdmin URL>
Query Tool frame：<frame URL>
snippet：<文件版本或 git commit>
Worker：active / main-thread fallback
Editor：adopted / not adopted
Snapshot：<name>, <schema count> schemas, <relation count> relations, <warning count> warnings
功能矩阵：通过数量 / 总数量
发现的问题：<实际问题>
修复内容：<文件和行为变化>
回归测试：<命令和结果>
环境异常：<500、断连、登录等待等>
```

## 10. 本地验证和真实站点验证的分工

先运行纯 Node 测试，再访问真实站点：

```powershell
node pg4-smart-assist-snippet/test/headless.mjs
```

分工如下：

```text
headless.mjs
    → tokenizer / DDL parser / completion / diagnostics / danger / worker source

smoke.html
    → 最小 CM6 编辑器、el.cmView 路径、本地 E2E

真实 pgAdmin
    → iframe、webpack EditorView 挖掘、真实 Execute 按钮、Shadow DOM UI、站点连接状态
```

真实站点测试不能替代 headless 测试；它用于确认集成边界和用户可见行为。

## 11. 增量记录新技术事实

后续发现 pgAdmin 4 的新页面结构或运行时行为时，按以下格式追加记录：

```text
发现日期：YYYY-MM-DD
pgAdmin 版本或构建：<可见版本、部署信息或未知>
页面/功能：<例如 Query Tool、对象浏览器、结果面板>
观察条件：<URL、frame、操作步骤和前置状态>
观察结果：<DOM、事件、对象或控制台证据>
对增强功能的影响：<可利用的接口、兼容性风险或降级策略>
验证方式：<手工步骤、smoke.html、headless.mjs 或真实站点>
```

记录技术事实时区分三类结论：

1. **稳定事实**：多个版本或多个部署环境均观察到的行为，可作为实现依据。
2. **当前构建事实**：只在某个 pgAdmin 构建中确认，必须附版本或证据，不能直接泛化。
3. **待验证假设**：由页面结构或错误日志推测，不能作为功能通过标准。
