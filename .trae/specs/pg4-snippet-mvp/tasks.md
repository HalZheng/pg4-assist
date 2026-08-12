# Tasks

> 注:本 spec 之前已实施过一次,但项目目录 `/pg4-smart-assist-snippet/` 在某次环境重置中丢失。以下任务全部恢复为未完成状态,需重新实施。设计决策与算法参考 `/workspace/src/` 下的 TS 实现。

## 阶段 0:项目初始化

- [ ] Task 1: 创建项目骨架 `/pg4-smart-assist-snippet`
  - [ ] SubTask 1.1: 新建目录 `/pg4-smart-assist-snippet`,初始化 `README.md`(简述项目目的、运行方式)
  - [ ] SubTask 1.2: 创建主源文件 `pg4-snippet.js`,顶部写 `CONFIG` 常量骨架(所有可调参数 + 默认值 + 注释)
  - [ ] SubTask 1.3: 创建 `smoke.html`(本地测试用最小 CM6 playground,引入 codemirror.net 的 ES module 版本,用于脱离 pgAdmin 验证 snippet)
  - [ ] SubTask 1.4: 创建 `.gitignore`(忽略 node_modules、.DS_Store 等,虽无构建但不排除未来加工具链)
  - [ ] SubTask 1.5: 创建 `.scratch/` 子目录存放模块草稿(.gitkeep 占位)

## 阶段 1:存储层

- [ ] Task 2: 实现 IndexedDB 封装(参考 `/workspace/src/storage/db.ts` 算法,JS 重写)
  - [ ] SubTask 2.1: 实现 `openDb()`,创建 `snapshots`/`schemaGraphs`/`usage`/`queryHistory` 四个 store(去掉 `hostBindings`、`settings`、`snippets`)
  - [ ] SubTask 2.2: 实现 `putSnapshot`/`getSnapshot`/`listSnapshotMetas`/`deleteSnapshot`
  - [ ] SubTask 2.3: 实现 `putSchemaGraph`/`getSchemaGraph`
  - [ ] SubTask 2.4: 实现 `recordUsage`/`getUsageForSnapshot`/`getUsageMap`
  - [ ] SubTask 2.5: 实现 `addQueryHistory`/`listQueryHistory`/`clearQueryHistory`(写入保留,UI 不做)
  - [ ] SubTask 2.6: 实现配额保护(历史 20000 条 / 100MB,DDL 总量 250MB)
- [ ] Task 3: 实现 localStorage 配置层
  - [ ] SubTask 3.1: 实现 `getActiveSnapshotId()`/`setActiveSnapshotId(id|null)` 读写 `pg4.activeSnapshotId`
  - [ ] SubTask 3.2: 监听 `window` `storage` 事件,触发活跃快照重载回调

## 阶段 2:DDL 解析与 Schema 索引

- [ ] Task 4: 实现 SQL tokenizer(参考 `/workspace/src/lib/sql-tokenizer.ts`,JS 重写)
  - [ ] SubTask 4.1: 支持单引号字符串、双引号标识符、`--` 行注释、`/* */` 块注释、dollar-quote `$tag$...$tag$`
  - [ ] SubTask 4.2: 实现 `splitStatements()` 按分号分割(忽略字符串/注释/dollar-quote 内的分号)
  - [ ] SubTask 4.3: 实现 `significantTokens()` 过滤空白与注释
- [ ] Task 5: 实现 DDL parser(参考 `/workspace/src/lib/ddl-parser.ts`,JS 重写)
  - [ ] SubTask 5.1: 识别 `CREATE SCHEMA`
  - [ ] SubTask 5.2: 识别 `CREATE TABLE` 含列、类型、NOT NULL、DEFAULT、主键、唯一键、外键
  - [ ] SubTask 5.3: 识别 `ALTER TABLE ... ADD CONSTRAINT`
  - [ ] SubTask 5.4: 识别 `CREATE VIEW`/`CREATE MATERIALIZED VIEW`/`CREATE FOREIGN TABLE` 对象名
  - [ ] SubTask 5.5: 识别 `COMMENT ON TABLE`/`COMMENT ON COLUMN`
  - [ ] SubTask 5.6: 识别 `CREATE [OR REPLACE] FUNCTION` 函数名、参数、返回类型
  - [ ] SubTask 5.7: 识别 `CREATE INDEX` 索引列
  - [ ] SubTask 5.8: 实现标识符大小写规范化(未加引号小写匹配,加引号精确匹配)
  - [ ] SubTask 5.9: 实现 warning 收集(行号 + 摘要 + code + message),不阻塞导入
- [ ] Task 6: 实现 JSONB annotation parser(参考 `/workspace/src/lib/jsonb-parser.ts`,JS 重写)
  - [ ] SubTask 6.1: 解析 `-- @pg4-jsonb schema.table.column path:type "comment"` 注释
  - [ ] SubTask 6.2: 支持 `.` 分段、`[]` 数组、JSON Pointer 转义
  - [ ] SubTask 6.3: 构建 `JsonbPathNode` 树并附加到对应 ColumnNode
- [ ] Task 7: 实现 Schema 索引构建(参考 `/workspace/src/lib/schema-index.ts`,JS 重写)
  - [ ] SubTask 7.1: 实现 `buildIndex(graph)`,生成 `relations`/`relationByName`/`columns`/`columnsByRelation`/`schemas` 五个反查 Map
  - [ ] SubTask 7.2: 实现索引按 lowercased key 查询,public schema 优先

## 阶段 3:上下文解析与补全

- [ ] Task 8: 实现 SQL 上下文解析器(参考 `/workspace/src/lib/context-parser.ts`,JS 重写)
  - [ ] SubTask 8.1: 实现光标前 token 与 prefix 提取
  - [ ] SubTask 8.2: 识别 `FROM`/`JOIN`/`UPDATE`/`INTO` 后的 relation 槽位
  - [ ] SubTask 8.3: 识别 `schema.` 后的 schema-relation 槽位
  - [ ] SubTask 8.4: 识别 `SELECT`/`WHERE`/`ON`/`GROUP BY`/`ORDER BY`/`HAVING` 后的 column 槽位
  - [ ] SubTask 8.5: 识别 `alias.` / `table.` 后的 qualified-column 槽位
  - [ ] SubTask 8.6: 识别 `INSERT INTO table (` 后的 insert-column 槽位
  - [ ] SubTask 8.7: 识别 `VALUES (` 后的 insert-value 槽位
  - [ ] SubTask 8.8: 识别 `WITH name AS (` 后的 cte-name 槽位
  - [ ] SubTask 8.9: 识别 `jsonColumn ->` / `->>` / `#>` / `#>>` 后的 jsonb-path 槽位
  - [ ] SubTask 8.10: 建立 relation map(表、视图、CTE、子查询投影、别名)
  - [ ] SubTask 8.11: 实现容错(未闭合引号/括号不抛异常)
- [ ] Task 9: 实现补全引擎与排序(参考 `/workspace/src/lib/completion-engine.ts` + `completion-ranker.ts` + `sql-reference.ts`,JS 重写)
  - [ ] SubTask 9.1: 根据 CompletionContext.slot 生成候选(table/view/column/function/keyword/cte/jsonb-path)
  - [ ] SubTask 9.2: 实现排序公式 `S = 0.40M + 0.20R + 0.15F + 0.10L + 0.10K + 0.05D`
  - [ ] SubTask 9.3: 实现冷启动策略(无历史时仅用 M + K + D,稳定字母序决胜)
  - [ ] SubTask 9.4: 实现 `maxCandidates` 截断
  - [ ] SubTask 9.5: 实现 `showSystemTables` 过滤(pg_catalog/information_schema 默认隐藏)

## 阶段 4:诊断与危险检测

- [ ] Task 10: 实现诊断引擎(参考 `/workspace/src/lib/diagnostics.ts`,JS 重写)
  - [ ] SubTask 10.1: 红色诊断:未闭合引号、括号失衡、关键子句顺序错误、无法识别 token
  - [ ] SubTask 10.2: 黄色诊断:类型不匹配(如 `integer_column = 'abc'`)、不存在的 `alias.column`、INSERT 列数与 VALUES 数量不一致
  - [ ] SubTask 10.3: 实现 300ms debounce 入口
  - [ ] SubTask 10.4: 文档 > 500KB 时只诊断光标所在语句
- [ ] Task 11: 实现危险语句检测(参考 `/workspace/src/lib/danger-detector.ts`,JS 重写)
  - [ ] SubTask 11.1: 识别 `DELETE`/`UPDATE` 无 `WHERE`
  - [ ] SubTask 11.2: 识别 `WHERE 1=1`/`WHERE TRUE`/`WHERE 'x'='x'` 恒真条件
  - [ ] SubTask 11.3: 识别 `TRUNCATE`/`DROP TABLE`/`DROP SCHEMA`/`DROP DATABASE`/`ALTER TABLE DROP COLUMN`
  - [ ] SubTask 11.4: 提取目标对象名
  - [ ] SubTask 11.5: 实现 `canExplainStatement()` 判断(仅 DELETE/UPDATE)

## 阶段 5:Worker 与主线程降级

- [ ] Task 12: 实现 Blob URL Worker + 主线程降级
  - [ ] SubTask 12.1: 把 DDL parser + schema-index + context-parser + completion-engine + diagnostics 打包成 Worker 源码字符串(模板字面量内联)
  - [ ] SubTask 12.2: 实现 `createWorker()`,尝试 `URL.createObjectURL(new Blob([src]))` 构造 Worker
  - [ ] SubTask 12.3: 实现 `ping` 探测,500ms 超时则降级
  - [ ] SubTask 12.4: 捕获 `SecurityError`,标记 `workerAvailable = false`,降级到主线程同步执行
  - [ ] SubTask 12.5: 实现 Worker RPC 封装(`call(method, args)` 返回 Promise)
  - [ ] SubTask 12.6: 主线程降级路径:直接调用本地模块同名函数,接口与 Worker RPC 一致

## 阶段 6:CM6 编辑器发现与接管

- [ ] Task 13: 实现 CM6 编辑器发现(参考 `/workspace/src/bridge/main-world-bridge.ts`,JS 重写)
  - [ ] SubTask 13.1: 实现 `findEditorViewFromWebpack()`,扫描 `window.webpackChunk` 与 `webpackChunk<name>`,mini-require 重建模块图,找带 `findFromDOM` 静态方法的类(关键约束:不加 `create` 条件)
  - [ ] SubTask 13.2: 实现 `findViewOnElement(el)`,优先 `el.cmView?.view`,失败回退 `EditorView.findFromDOM(el)`
  - [ ] SubTask 13.3: 实现 `tryAdoptEditor(el)`,验证 view.state.doc / dispatch / coordsAtPos 可用,分配 editorId
  - [ ] SubTask 13.4: 实现 `dispatchCompletion(view, from, to, insert)` 工具函数(userEvent: 'input')
  - [ ] SubTask 13.5: 实现 MutationObserver 监听新 `.cm-editor` 元素
  - [ ] SubTask 13.6: 实现编辑器销毁清理(DOM 移除时清理会话)

## 阶段 7:Overlay UI

- [ ] Task 14: 实现 Shadow DOM overlay host(参考 `/workspace/src/content/overlay-host.ts`,JS 重写)
  - [ ] SubTask 14.1: 创建 `#pg4-overlay-root` 容器,`attachShadow({mode: 'open'})`
  - [ ] SubTask 14.2: 注入基础 CSS 变量(明暗主题色板,含 --pg4-bg/--pg4-fg/--pg4-border/--pg4-accent/--pg4-warn/--pg4-error/--pg4-bg-elevated/--pg4-shadow)
  - [ ] SubTask 14.3: 实现主题检测(pgAdmin DOM 背景亮度 + `prefers-color-scheme` 兜底)
  - [ ] SubTask 14.4: 实现 MutationObserver 监听 pgAdmin DOM 主题切换(300ms debounce)
  - [ ] SubTask 14.5: 实现 `attachOverlayElement(tag, props, style)` 工具函数
- [ ] Task 15: 实现补全菜单(参考 `/workspace/src/content/completion-menu.ts`,JS 重写)
  - [ ] SubTask 15.1: 渲染候选列表(最多 50 项),每项显示 label + detail + kind 图标(emoji)
  - [ ] SubTask 15.2: 键盘导航:↑/↓/PageUp/PageDown/Home/End/Enter/Tab/Escape
  - [ ] SubTask 15.3: 鼠标 hover/click 选择
  - [ ] SubTask 15.4: ARIA combobox/listbox 语义
  - [ ] SubTask 15.5: 跟随光标坐标定位(`view.coordsAtPos(cursor)`),空间不足翻上方
  - [ ] SubTask 15.6: 选中后调用 `onApply(item, from, to)` callback 或直接 dispatch
- [ ] Task 16: 实现 hover card(参考 `/workspace/src/content/hover-card.ts`,JS 重写)
  - [ ] SubTask 16.1: 350ms hover debounce
  - [ ] SubTask 16.2: 显示限定名、类型、可空、默认值、注释、主键/外键
  - [ ] SubTask 16.3: 150ms 离开延迟(避免移到浮层时闪烁)
  - [ ] SubTask 16.4: JSONB 列显示已声明根路径数量
  - [ ] SubTask 16.5: 输入时立即隐藏(通过包装 view.update 检测 docChanged)
- [ ] Task 17: 实现 diagnostics overlay(参考 `/workspace/src/content/diagnostics-overlay.ts`,JS 重写)
  - [ ] SubTask 17.1: 采用 DOM 叠加层方案(不重写 CM6 lint 插件或 pgAdmin 原生 decorations)
  - [ ] SubTask 17.2: 在 shadow root 内创建 `.pg4-diag-layer` 绝对定位 div,根据诊断行号/列号渲染波浪线 span
  - [ ] SubTask 17.3: 监听 CM6 scroll/resize 事件更新位置(rAF 批量)
  - [ ] SubTask 17.4: hover 诊断项显示 message tooltip
  - [ ] SubTask 17.5: 诊断数 > 100 时只渲染 viewport 内
- [ ] Task 18: 实现 danger dialog(参考 `/workspace/src/content/danger-dialog.ts`,JS 重写)
  - [ ] SubTask 18.1: 显示语句类别、目标对象、风险原因
  - [ ] SubTask 18.2: 「取消」/「继续执行」/「预估影响行数」三个按钮(预估按钮仅 canExplain=true 显示)
  - [ ] SubTask 18.3: 取消时不吞掉后续事件(一次性 Promise 模式)
  - [ ] SubTask 18.4: 继续 → resolve 'continue' 给调用方 re-dispatch click(调用方维护标志位防循环)
  - [ ] SubTask 18.5: 预估 → 通过受控 dispatch 改写为 EXPLAIN 后让用户点执行

## 阶段 8:编辑增强

- [ ] Task 19: 实现智能粘贴(参考 `/workspace/src/content/content-script.ts` 的 `onPaste`,JS 重写)
  - [ ] SubTask 19.1: 监听 `paste` 事件,读取 `clipboardData.getData("text/plain")`
  - [ ] SubTask 19.2: 条件判断:无换行、≤256 字符、无引号
  - [ ] SubTask 19.3: 上下文分类:string 槽位 / identifier 槽位
  - [ ] SubTask 19.4: preventDefault 后通过 `view.dispatch` 插入包裹后的文本
- [ ] Task 20: 实现危险语句拦截
  - [ ] SubTask 20.1: 监听 `document` `click` capture phase
  - [ ] SubTask 20.2: 匹配 pgAdmin 执行按钮(`button[aria-label*="Execute" i]` 等)
  - [ ] SubTask 20.3: 调用 `quickDetectDangerSync(sql)` 同步检测
  - [ ] SubTask 20.4: 命中则 preventDefault + stopImmediatePropagation + 弹出 DangerDialog
  - [ ] SubTask 20.5: 用户确认后 re-dispatch click(用内部标志位 `__pg4BypassClick` 防循环)或执行 EXPLAIN 流程
- [ ] Task 21: 实现 Ctrl+Space 强制补全
  - [ ] SubTask 21.1: 监听 `keydown`,匹配 CONFIG.completionShortcut
  - [ ] SubTask 21.2: preventDefault 后触发 `forceTriggerCompletion()`

## 阶段 9:控制面板 UI

- [ ] Task 22: 实现浮动按钮 + 抽屉骨架
  - [ ] SubTask 22.1: 在 shadow 内创建齿轮按钮(48x48px,半透明,hover 不透明)
  - [ ] SubTask 22.2: 点击展开抽屉(宽 360px,高自适应,最大 80vh 可滚)
  - [ ] SubTask 22.3: 抽屉三个 tab:导入 / 切换 / 删除(占位 div,Task 23-25 填充)
  - [ ] SubTask 22.4: Escape 或再次点击按钮关闭抽屉
  - [ ] SubTask 22.5: 提供 `onSnapshotImported/Switched/Deleted` 回调注册接口
- [ ] Task 23: 实现快照导入分区
  - [ ] SubTask 23.1: `<input type="file" accept=".sql,.txt,.ddl">` + 名称输入框 + 导入按钮
  - [ ] SubTask 23.2: 文件选择后自动填充名称(去后缀)
  - [ ] SubTask 23.3: 点击导入:读取文件 → parseDdl → buildIndex → 写 IndexedDB → 刷新列表
  - [ ] SubTask 23.4: 导入期间禁用按钮显示「导入中...」
  - [ ] SubTask 23.5: 显示 warning 数量,可展开查看 warning 列表(行号 + code + message)
  - [ ] SubTask 23.6: 拖拽支持:dragover/drop 事件,释放后自动读取文件
- [ ] Task 24: 实现快照切换分区
  - [ ] SubTask 24.1: 列出所有快照(displayName / schema 数 / relation 数 / 导入时间)
  - [ ] SubTask 24.2: radio 选择当前活跃快照(默认选中 `localStorage["pg4.activeSnapshotId"]`)
  - [ ] SubTask 24.3: 切换 → 写 `localStorage["pg4.activeSnapshotId"]` → 加载到 `activeGraph` → 触发 `storage` 事件同步其他 tab
- [ ] Task 25: 实现快照删除分区
  - [ ] SubTask 25.1: 列出所有快照(同上)
  - [ ] SubTask 25.2: 每行「删除」按钮,点击后 `confirm()` 确认
  - [ ] SubTask 25.3: 删除 → 清理 IndexedDB(snapshots + schemaGraphs + usage) → 若是活跃快照则清空 activeSnapshotId → 刷新列表

## 阶段 10:启动编排

- [ ] Task 26: 实现 snippet 启动主流程
  - [ ] SubTask 26.1: 顶层 IIFE 包裹,捕获所有异常
  - [ ] SubTask 26.2: 幂等检查(若 `window.__pg4Active` 已存在则跳过)
  - [ ] SubTask 26.3: 初始化 overlay host + 主题检测
  - [ ] SubTask 26.4: 初始化 IndexedDB + localStorage 读取
  - [ ] SubTask 26.5: 创建 Blob Worker(或降级)
  - [ ] SubTask 26.6: 加载活跃快照到 `activeGraph`
  - [ ] SubTask 26.7: 注册 MutationObserver 接管编辑器
  - [ ] SubTask 26.8: 注册 paste / keydown / click 监听
  - [ ] SubTask 26.9: 注册 storage 事件监听
  - [ ] SubTask 26.10: 注入浮动按钮 + 抽屉
  - [ ] SubTask 26.11: 控制台输出 `[pg4] snippet: started`
  - [ ] SubTask 26.12: 支持 `CONFIG.runMode = "overrides"` 自动注入模式(行为一致)

## 阶段 11:验证

- [ ] Task 27: smoke 测试(`smoke.html` + 本地 CM6 playground)
  - [ ] SubTask 27.1: 验证 snippet 在 smoke.html 中能发现 CM6 编辑器(通过 `el.cmView` 路径,webpack 路径无法测)
  - [ ] SubTask 27.2: 验证补全菜单出现、键盘选择、插入、Undo/Redo 正常
  - [ ] SubTask 27.3: 验证诊断波浪线渲染
  - [ ] SubTask 27.4: 验证 hover card 显示
  - [ ] SubTask 27.5: 验证 Blob Worker 创建成功
- [ ] Task 28: pgAdmin4 真实环境验证
  - [ ] SubTask 28.1: 在目标 pgAdmin 站点运行 snippet,验证 `[pg4] snippet: started` 日志
  - [ ] SubTask 28.2: 验证 webpack EditorView 发现成功
  - [ ] SubTask 28.3: 验证编辑器接管、补全、诊断、hover
  - [ ] SubTask 28.4: 验证 DDL 文件导入、活跃快照切换
  - [ ] SubTask 28.5: 验证刷新页面后重新运行 snippet,活跃快照自动加载
  - [ ] SubTask 28.6: 验证 Blob Worker 在 pgAdmin CSP 下的行为(若被拦截则验证主线程降级)
  - [ ] SubTask 28.7: 验证危险语句拦截(EXPLAIN 流程)
  - [ ] SubTask 28.8: 验证多 Query Tool tab 接管
  - [ ] SubTask 28.9: 验证跨 tab storage 事件同步活跃快照
  - [ ] SubTask 28.10: 验证 snippet 失败时 pgAdmin 原生行为不受影响

# Task Dependencies

- Task 2、Task 3 可并行(分别对应 IndexedDB 与 localStorage)
- Task 4 是 Task 5、Task 6 的依赖(tokenizer 是基础)
- Task 5、Task 6、Task 7 可并行(都依赖 Task 4,但相互独立)
- Task 8 依赖 Task 7(需要 schema 索引)
- Task 9 依赖 Task 8(需要 CompletionContext)
- Task 10、Task 11 可并行(独立)
- Task 12 依赖 Task 4-9、Task 10(Worker 需内联这些模块源码)
- Task 13 独立(CM6 发现)
- Task 14 独立(Shadow DOM host)
- Task 15、Task 16、Task 17、Task 18 依赖 Task 14(都需要 shadow root)
- Task 19、Task 20、Task 21 依赖 Task 13、Task 9(需要编辑器实例与补全)
- Task 22 依赖 Task 14(浮动按钮放 shadow 内)
- Task 23、Task 24、Task 25 依赖 Task 2、Task 22(需要存储与抽屉)
- Task 26 依赖所有前置任务
- Task 27、Task 28 依赖 Task 26
