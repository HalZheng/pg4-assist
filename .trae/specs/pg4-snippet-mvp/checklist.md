# Checklist

## 部署形态

- [ ] snippet 是单文件 `.js`,无 `import`/`export`,无构建步骤,无 npm 依赖
- [ ] snippet 顶部有 `CONFIG` 常量,包含所有可调参数及注释
- [ ] snippet 顶部有 `CONFIG.runMode`(`"snippet"` | `"overrides"`),默认 `"snippet"`
- [ ] 顶层 IIFE 包裹,所有异常被捕获,不抛未捕获异常到 pgAdmin

## CM6 编辑器接管

- [ ] 通过 `window.webpackChunk` + mini-require 找到带 `findFromDOM` 静态方法的类(不加 `create` 条件)
- [ ] 调用 `findFromDOM(el)` 拿到 view 实例,验证 `state.doc`/`dispatch`/`coordsAtPos` 可用
- [ ] 优先 `el.cmView?.view`,失败回退 `EditorView.findFromDOM(el)`
- [ ] 直接 `view.dispatch({changes, selection, userEvent: "input"})` 写入,保留 Undo/Redo
- [ ] 不通过任何 postMessage 或 CustomEvent 中转
- [ ] MutationObserver 接管新出现的 `.cm-editor` 元素
- [ ] 编辑器 DOM 移除时会话状态被清理

## 存储

- [ ] IndexedDB 库名 `pg4-smart-assist`,在 pgAdmin 页面源下
- [ ] IndexedDB store 包含:`snapshots`、`schemaGraphs`、`usage`、`queryHistory`(不含 `hostBindings`、`settings`、`snippets`)
- [ ] localStorage 所有 key 加 `pg4.` 前缀,活跃快照 id 存 `pg4.activeSnapshotId`
- [ ] 配额保护:历史 20000 条 / 100MB,DDL 总量 250MB
- [ ] snippet 启动时自动从 IndexedDB 加载活跃快照到 `activeGraph`
- [ ] 监听 `storage` 事件实现跨 tab 活跃快照同步

## Worker 与降级

- [ ] 通过 `URL.createObjectURL(new Blob([src], {type: 'text/javascript'}))` 创建 Worker
- [ ] Worker 负责 DDL 解析、补全候选计算、诊断三个重活
- [ ] 危险检测、hover 解析在主线程同步执行
- [ ] Worker 创建抛 `SecurityError` 时捕获并降级到主线程
- [ ] Worker `ping` 探测 500ms 超时则降级
- [ ] 降级路径与 Worker RPC 接口一致(同一调用签名)

## DDL 解析

- [ ] 支持 `CREATE SCHEMA`、`CREATE TABLE`(含列/类型/约束)、`ALTER TABLE ADD CONSTRAINT`
- [ ] 支持 `CREATE VIEW`/`CREATE MATERIALIZED VIEW`/`CREATE FOREIGN TABLE`
- [ ] 支持 `COMMENT ON TABLE`/`COMMENT ON COLUMN`
- [ ] 支持 `CREATE [OR REPLACE] FUNCTION`
- [ ] 支持 `CREATE INDEX`
- [ ] 支持 `-- @pg4-jsonb schema.table.column path:type "comment"` 注解
- [ ] JSONB path 支持 `.` 分段、`[]` 数组、JSON Pointer 转义
- [ ] 标识符大小写规范化:未加引号小写匹配,加引号精确匹配
- [ ] 不能解析的语句收集为 warning(行号 + 摘要 + code + message),不阻塞导入
- [ ] 50MB DDL 导入可完成(Worker 模式不阻塞 UI,降级模式主线程 1-3 秒可接受)

## 上下文补全

- [ ] 识别 `FROM`/`JOIN`/`UPDATE`/`INTO` 后 relation 槽位
- [ ] 识别 `schema.` 后 schema-relation 槽位
- [ ] 识别 `SELECT`/`WHERE`/`ON`/`GROUP BY`/`ORDER BY`/`HAVING` 后 column 槽位
- [ ] 识别 `alias.`/`table.` 后 qualified-column 槽位
- [ ] 识别 `INSERT INTO table (` 后 insert-column 槽位
- [ ] 识别 `VALUES (` 后 insert-value 槽位
- [ ] 识别 `WITH name AS (` 后 cte-name 槽位
- [ ] 识别 `jsonColumn ->`/`->>`/`#>`/`#>>` 后 jsonb-path 槽位
- [ ] 建立别名/CTE/子查询 relation map
- [ ] 容错:未闭合引号/括号不抛异常
- [ ] 排序公式 `S = 0.40M + 0.20R + 0.15F + 0.10L + 0.10K + 0.05D`
- [ ] 冷启动(无历史)仅用 M + K + D,稳定字母序决胜
- [ ] `maxCandidates` 截断生效
- [ ] `showSystemTables = false` 时 pg_catalog/information_schema 隐藏
- [ ] 自动触发:2 字符后或 `.`/`->`/`->>`/`#>`/`#>>` 立即触发
- [ ] Ctrl+Space 强制触发(支持 CONFIG.completionShortcut 配置)

## 补全菜单交互

- [ ] 最多渲染 50 项
- [ ] 键盘 ↑/↓/PageUp/PageDown/Home/End/Enter/Tab/Escape 可用
- [ ] 鼠标 hover/click 选择
- [ ] ARIA combobox/listbox 语义,aria-activedescendant 指向当前选中项
- [ ] 跟随光标坐标定位(`view.coordsAtPos(cursor)`),空间不足翻上方
- [ ] 选中后调用 `onApply(item, from, to)` 或直接 dispatch 替换 `[from, to)`
- [ ] prefix 命中部分高亮

## 诊断

- [ ] 红色诊断:未闭合引号、括号失衡、关键子句顺序错误、无法识别 token
- [ ] 黄色诊断:类型不匹配、不存在的 `alias.column`、INSERT 列数与 VALUES 数量不一致
- [ ] 300ms debounce
- [ ] 文档 > 500KB 时只诊断光标所在语句
- [ ] 不重写 CM6 lint 插件或 pgAdmin 原生 decorations(用 DOM 叠加层方案)
- [ ] 不把可隐式转换的合法表达式误报为红色
- [ ] DOM 叠加层方案:监听 scroll/resize 更新波浪线位置

## Hover

- [ ] 350ms hover debounce
- [ ] 显示限定名、类型、可空、默认值、注释、主键/外键
- [ ] 150ms 离开延迟(避免移到浮层时闪烁)
- [ ] JSONB 列显示已声明根路径数量
- [ ] 未知或不可唯一解析的名称不显示误导性文档
- [ ] 输入时立即隐藏 hover card

## 智能粘贴

- [ ] 仅触发条件:纯文本、无换行、≤256 字符、无引号
- [ ] WHERE/VALUES 的 text/uuid/date 列自动加单引号并转义 `'`
- [ ] 标识符槽位且含大写/空格/特殊字符时加双引号
- [ ] 数字/boolean 列值不加引号
- [ ] 已在字符串/注释/dollar quote 内不改写
- [ ] preventDefault 后通过 `view.dispatch` 插入

## 危险拦截

- [ ] 识别 DELETE/UPDATE 无 WHERE
- [ ] 识别 WHERE 1=1 / TRUE / 'x'='x' 恒真条件
- [ ] 识别 TRUNCATE / DROP TABLE / DROP SCHEMA / DROP DATABASE / ALTER TABLE DROP COLUMN
- [ ] 提取目标对象名
- [ ] 监听 `document` `click` capture phase,匹配执行按钮
- [ ] 命中后 preventDefault + stopImmediatePropagation + 弹 DangerDialog
- [ ] DangerDialog 显示类别、目标对象、风险原因
- [ ] 取消时不吞掉后续事件(一次性 Promise)
- [ ] 继续 → re-dispatch click(用内部标志位防循环)
- [ ] 预估 → 受控 dispatch 改写为 EXPLAIN 后让用户点执行
- [ ] EXPLAIN 失败/DDL 目标/版本不支持时显示「无法预估」而非执行原语句
- [ ] CONFIG.dangerInterceptEnabled = false 时不拦截

## UI

- [ ] 单一浮动按钮在页面右下角(48x48px,半透明,hover 不透明)
- [ ] 按钮使用 Shadow DOM 隔离样式
- [ ] 按钮跟随 pgAdmin 明暗主题
- [ ] 点击展开抽屉(宽 360px,高自适应,最大 80vh 可滚)
- [ ] 抽屉三个分区:导入 / 切换 / 删除
- [ ] 导入分区支持文件选择 + 拖拽
- [ ] 切换分区显示快照列表 + radio 选择
- [ ] 删除分区显示快照列表 + 每行删除按钮
- [ ] Escape 或再次点击按钮关闭抽屉

## 启动与降级

- [ ] 幂等:重复运行 snippet 不重复创建按钮/Worker/监听
- [ ] 启动时从 IndexedDB 加载活跃快照(若存在)
- [ ] 启动时无活跃快照则补全降级为关键词/内置函数
- [ ] 任意错误被捕获,console 输出 `[pg4] error: <message>`,pgAdmin 原生行为不受影响
- [ ] `CONFIG.runMode = "overrides"` 时行为与 `"snippet"` 一致,支持 Local Overrides 自动注入

## 跨 tab 同步

- [ ] 监听 `window` `storage` 事件
- [ ] `pg4.activeSnapshotId` 变更时重载活跃快照
- [ ] 同源多 tab 间活跃快照切换自动同步

## pgAdmin 真实环境验证

- [ ] snippet 在目标 pgAdmin 站点运行后控制台输出 `[pg4] snippet: started`
- [ ] webpack EditorView 发现成功(`[pg4] editor adopted cm-xxx`)
- [ ] 补全菜单出现且候选正确
- [ ] 诊断波浪线渲染
- [ ] hover card 显示
- [ ] DDL 文件导入成功
- [ ] 切换活跃快照后补全候选立即变化
- [ ] 刷新页面后重新运行 snippet,活跃快照自动加载
- [ ] Blob Worker 在 pgAdmin CSP 下:成功或自动降级
- [ ] 危险语句拦截与 EXPLAIN 流程
- [ ] 多 Query Tool tab 接管
- [ ] 跨 tab storage 事件同步活跃快照
- [ ] snippet 失败时 pgAdmin 原生行为不受影响
