/*!
 * PG4 Assist — pgAdmin 4 Query Tool 离线增强层（单文件，无构建、无依赖）
 * =============================================================================
 * 目标站点实测：pgAdmin 9.10（app_version_int 91000），CodeMirror 6。
 *
 * 与旧版 pg4-snippet.js 的根本差异：
 *   旧版自建 Shadow DOM 补全菜单 / 悬停卡 / 诊断层，自己算坐标、自己处理键盘。
 *   本版从 webpack 运行时取出 pgAdmin 自己那份 CodeMirror 模块实例，
 *   直接注册**原生 CM6 扩展**（autocompletion / hoverTooltip / Decoration / domEventHandlers），
 *   因此补全弹层、键盘导航、模糊高亮、定位、主题全部由 CM6 负责。
 *
 * 运行形态（同一份文件自适应）：
 *   1. DevTools → Sources → Snippets → Ctrl+Enter（在**顶层页面**上下文运行即可）
 *   2. Tampermonkey / 用户脚本（建议 @match https://<host>/*  且允许所有 frame）
 *   3. DevTools Local Overrides 自动注入
 *
 * 关键实测事实（改动前务必先读）：
 *   - Query Tool 位于**同源 iframe** /sqleditor/panel/<id>；顶层文档里 .cm-editor 数量为 0。
 *   - 外层 DIV 与 IFRAME **共用同一个 id**，getElementById 会拿到 DIV，必须用 querySelectorAll('iframe')。
 *   - cmView 挂在 **.cm-content** 上，不是 .cm-editor。
 *   - 取真 __webpack_require__ 必须走 webpackChunk.push 的第三个回调参数；
 *     绝不能自己重放 factory，那会得到 CM6 模块的副本，facet 身份不一致。
 *   - 不能 appendConfig(autocompletion({override})) —— 该版本 completionConfig 对 override
 *     没有 combiner，会抛 "Config merge conflict for field override"。
 *     只能就地替换已解析配置里的 override[0]（数组引用与 pgAdmin 传入的 config 共享）。
 */
(() => {
  "use strict";

  const VERSION = "2.2.4";
  const NS = "__pg4Assist";

  // ═══════════════════════════════════════════════════════════════════════════
  // §0  配置
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG_KEY = "pg4.assist.config";
  /** 配置结构版本。改动默认值语义时递增，并在 loadConfig 里做一次性迁移。 */
  const CONFIG_VERSION = 2;

  const DEFAULT_CONFIG = {
    configVersion: CONFIG_VERSION,
    completionEnabled: true,
    /** 输入多少个字符后自动弹出补全（0 = 只在 . 或 " 之后弹） */
    autoTriggerMinChars: 1,
    autoTriggerDelayMs: 90,
    /** 离线候选为空时回落到 pgAdmin 自带的服务端补全 */
    fallbackToNative: true,
    maxCandidates: 60,

    hoverEnabled: true,
    hoverDelayMs: 300,

    /**
     * 实时诊断默认关闭：它每次都要对整篇文档重新分词（实测约 0.22 ms / 1000 字符，
     * 39 万字符的脚本单次近 93 ms，每 400 ms 触发一次，相当于持续占用约 1/4 个核）。
     * 需要时可在面板「设置 → 诊断」里打开。
     */
    diagnosticsEnabled: false,
    diagnosticsDebounceMs: 400,
    diagUnknownObject: true,
    diagQuoteRequired: true,
    diagSelectStar: false,
    diagMissingWhere: true,

    smartPasteEnabled: true,

    /** 结果网格复制单单元格时自动去除外层双引号 */
    gridUnquoteSingleCell: true,

    historyEnabled: true,
    historyRetentionDays: 30,

    debug: false,
  };

  // IndexedDB
  const DB_NAME = "pg4-assist";
  const DB_VERSION = 1;
  const ST_SNAPSHOTS = "snapshots";
  const ST_GRAPHS = "graphs";
  const ST_USAGE = "usage";
  const ST_HISTORY = "history";

  const MAX_HISTORY_ROWS = 5000;

  /**
   * 大文档保护阈值（单位都是「字符数」，即 String.length，不是字节数）。
   * 三个功能各自有独立上限，改动前先看清楚是哪一层在起作用。
   */
  /** 超过此长度，诊断直接放弃（全量分词代价过高） */
  const MAX_DIAG_DOC_CHARS = 400_000;
  /** 超过此长度，补全/诊断只在光标附近取窗口，不再全文分词 */
  const ANALYZE_WINDOW_THRESHOLD = 200_000;
  const ANALYZE_WINDOW_BACK = 40_000;
  const ANALYZE_WINDOW_FWD = 4_000;

  // ═══════════════════════════════════════════════════════════════════════════
  // §1  基础工具
  // ═══════════════════════════════════════════════════════════════════════════

  const log = (...a) => console.log("[pg4]", ...a);
  const warn = (...a) => console.warn("[pg4]", ...a);
  const dbg = (...a) => { if (currentConfig && currentConfig.debug) console.debug("[pg4]", ...a); };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, ms) {
    let t = 0;
    const wrapped = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /** 同源判断 + 安全取 contentWindow */
  function sameOriginWindow(frameEl) {
    try {
      const w = frameEl.contentWindow;
      if (!w) return null;
      void w.location.href; // 跨源会抛
      return w;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §2  SQL 词法分析器（容错，永不抛异常）
  // ═══════════════════════════════════════════════════════════════════════════

  const RESERVED = new Set([
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "both",
    "case", "cast", "check", "collate", "column", "constraint", "create", "current_catalog",
    "current_date", "current_role", "current_time", "current_timestamp", "current_user",
    "default", "deferrable", "desc", "distinct", "do", "else", "end", "except", "false",
    "fetch", "for", "foreign", "from", "grant", "group", "having", "in", "initially",
    "intersect", "into", "lateral", "leading", "limit", "localtime", "localtimestamp",
    "not", "null", "offset", "on", "only", "or", "order", "placing", "primary", "references",
    "returning", "select", "session_user", "some", "symmetric", "table", "then", "to",
    "trailing", "true", "union", "unique", "user", "using", "variadic", "when", "where",
    "window", "with",
  ]);

  const KEYWORDS = new Set([
    ...RESERVED,
    "add", "after", "alter", "as", "asc", "before", "begin", "between", "by", "cascade",
    "columns", "comment", "commit", "concurrently", "conflict", "cross", "cube", "cycle",
    "database", "delete", "desc", "drop", "each", "escape", "exclude", "exists", "explain",
    "extension", "filter", "first", "following", "full", "function", "generated", "identity",
    "if", "ilike", "immediate", "include", "index", "inherits", "inner", "insert", "instead",
    "is", "isnull", "join", "key", "language", "last", "left", "like", "materialized",
    "natural", "next", "no", "nothing", "notnull", "nowait", "nulls", "of", "outer", "over",
    "overlaps", "owned", "owner", "partial", "partition", "preceding", "procedure", "range",
    "recursive", "replace", "restrict", "returns", "right", "rollback", "row", "rows",
    "schema", "sequence", "session", "set", "similar", "start", "storage", "tablespace",
    "temp", "temporary", "trigger", "truncate", "type", "unbounded", "unlogged", "update",
    "values", "view", "within", "without", "authorization", "btree", "gin", "gist", "hash",
  ]);

  const T = {
    IDENT: "ident",
    KEYWORD: "keyword",
    STRING: "string",
    NUMBER: "number",
    PUNCT: "punct",
    OP: "op",
    COMMENT: "comment",
    PARAM: "param",
    UNKNOWN: "unknown",
  };

  /**
   * @returns {{type:string,from:number,to:number,text:string,value?:string,quoted?:boolean,closed?:boolean}[]}
   */
  function tokenize(sql, opts = {}) {
    const keepComments = !!opts.keepComments;
    const tokens = [];
    const n = sql.length;
    let i = 0;

    while (i < n) {
      const ch = sql[i];

      // 空白
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
        i++;
        continue;
      }

      // 行注释
      if (ch === "-" && sql[i + 1] === "-") {
        let j = sql.indexOf("\n", i);
        if (j < 0) j = n;
        if (keepComments) tokens.push({ type: T.COMMENT, from: i, to: j, text: sql.slice(i, j) });
        i = j;
        continue;
      }

      // 块注释（可嵌套）
      if (ch === "/" && sql[i + 1] === "*") {
        let depth = 1, j = i + 2;
        while (j < n && depth > 0) {
          if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
          else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
          else j++;
        }
        if (keepComments) tokens.push({ type: T.COMMENT, from: i, to: j, text: sql.slice(i, j) });
        i = j;
        continue;
      }

      // 美元引用字符串 $tag$ ... $tag$（函数体）
      if (ch === "$") {
        const m = /^\$[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*\$|^\$\$/.exec(sql.slice(i, i + 64));
        if (m) {
          const tag = m[0];
          const close = sql.indexOf(tag, i + tag.length);
          const j = close < 0 ? n : close + tag.length;
          tokens.push({ type: T.STRING, from: i, to: j, text: sql.slice(i, j), closed: close >= 0 });
          i = j;
          continue;
        }
        // $1 占位参数
        if (/[0-9]/.test(sql[i + 1] || "")) {
          let j = i + 1;
          while (j < n && /[0-9]/.test(sql[j])) j++;
          tokens.push({ type: T.PARAM, from: i, to: j, text: sql.slice(i, j) });
          i = j;
          continue;
        }
      }

      // 单引号字符串（含 E'' / U&''，'' 转义）
      if (ch === "'" || ((ch === "e" || ch === "E" || ch === "b" || ch === "B" || ch === "x" || ch === "X") && sql[i + 1] === "'")) {
        let j = ch === "'" ? i + 1 : i + 2;
        let closed = false;
        while (j < n) {
          if (sql[j] === "'") {
            if (sql[j + 1] === "'") { j += 2; continue; }
            j++; closed = true; break;
          }
          if (sql[j] === "\\" && (ch === "e" || ch === "E")) { j += 2; continue; }
          j++;
        }
        tokens.push({ type: T.STRING, from: i, to: j, text: sql.slice(i, j), closed });
        i = j;
        continue;
      }

      // 双引号标识符（"" 转义）
      if (ch === '"') {
        let j = i + 1;
        let closed = false;
        let value = "";
        while (j < n) {
          if (sql[j] === '"') {
            if (sql[j + 1] === '"') { value += '"'; j += 2; continue; }
            j++; closed = true; break;
          }
          value += sql[j]; j++;
        }
        tokens.push({ type: T.IDENT, from: i, to: j, text: sql.slice(i, j), value, quoted: true, closed });
        i = j;
        continue;
      }

      // 数字
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] || ""))) {
        let j = i;
        while (j < n && /[0-9._eE+\-]/.test(sql[j])) {
          if ((sql[j] === "+" || sql[j] === "-") && !/[eE]/.test(sql[j - 1] || "")) break;
          j++;
        }
        tokens.push({ type: T.NUMBER, from: i, to: j, text: sql.slice(i, j) });
        i = j;
        continue;
      }

      // 标识符 / 关键字
      if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j])) j++;
        const text = sql.slice(i, j);
        const lower = text.toLowerCase();
        tokens.push(
          KEYWORDS.has(lower)
            ? { type: T.KEYWORD, from: i, to: j, text, value: lower }
            : { type: T.IDENT, from: i, to: j, text, value: text, quoted: false }
        );
        i = j;
        continue;
      }

      // 标点
      if ("(),;.[]".includes(ch)) {
        tokens.push({ type: T.PUNCT, from: i, to: i + 1, text: ch });
        i++;
        continue;
      }

      // JSON 操作符优先（->> #>> -> #> @> ?| ?& ||）
      const three = sql.slice(i, i + 3);
      const two = sql.slice(i, i + 2);
      if (three === "->>" || three === "#>>") {
        tokens.push({ type: T.OP, from: i, to: i + 3, text: three });
        i += 3;
        continue;
      }
      if (["->", "#>", "@>", "<@", "?|", "?&", "||", "::", ":=", "<>", "!=", "<=", ">=", "^@"].includes(two)) {
        tokens.push({ type: T.OP, from: i, to: i + 2, text: two });
        i += 2;
        continue;
      }

      tokens.push({ type: /[-+*/<>=~!@#%^&|`?:]/.test(ch) ? T.OP : T.UNKNOWN, from: i, to: i + 1, text: ch });
      i++;
    }

    return tokens;
  }

  /** 按顶层分号切分语句（丢弃注释） */
  function splitStatements(tokens) {
    const out = [];
    let cur = [];
    for (const t of tokens) {
      if (t.type === T.COMMENT) continue;
      if (t.type === T.PUNCT && t.text === ";") {
        if (cur.length) out.push(cur);
        cur = [];
        continue;
      }
      cur.push(t);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** PostgreSQL 标识符折叠规则：未加引号一律转小写 */
  const fold = (name, quoted) => (quoted ? name : String(name).toLowerCase());
  /** 供大小写不敏感检索用的键 */
  const searchKey = (name) => String(name).toLowerCase();

  const SAFE_IDENT_RE = /^[a-z_][a-z0-9_$]*$/;
  function needsQuote(name) {
    return !SAFE_IDENT_RE.test(name) || RESERVED.has(name.toLowerCase());
  }
  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }
  /** 按需加引号 */
  function renderIdent(name) {
    return needsQuote(name) ? quoteIdent(name) : name;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §3  DDL 解析器
  // ═══════════════════════════════════════════════════════════════════════════

  const GRAPH_VERSION = 2;

  function createGraph() {
    return {
      version: GRAPH_VERSION,
      schemas: Object.create(null), // schemaKey -> Schema
    };
  }

  function ensureSchema(graph, name, quoted) {
    const key = fold(name, quoted);
    let s = graph.schemas[key];
    if (!s) {
      s = graph.schemas[key] = {
        key,
        name,
        quoted,
        relations: Object.create(null),
        functions: Object.create(null),
        sequences: Object.create(null),
      };
    }
    return s;
  }

  /** 读取可能带 schema 前缀的限定名：a / a.b / "a"."b" */
  function readQualified(toks, i) {
    const parts = [];
    for (;;) {
      const t = toks[i];
      if (!t || (t.type !== T.IDENT && t.type !== T.KEYWORD)) break;
      parts.push({ name: t.value ?? t.text, quoted: !!t.quoted });
      i++;
      if (toks[i] && toks[i].type === T.PUNCT && toks[i].text === ".") { i++; continue; }
      break;
    }
    if (!parts.length) return null;
    const last = parts[parts.length - 1];
    const prev = parts.length >= 2 ? parts[parts.length - 2] : null;
    return {
      next: i,
      parts,
      name: last.name,
      quoted: last.quoted,
      schema: prev ? prev.name : null,
      schemaQuoted: prev ? prev.quoted : false,
    };
  }

  const COL_CONSTRAINT_KW = new Set([
    "not", "null", "default", "primary", "unique", "references", "check", "constraint",
    "generated", "collate", "identity", "deferrable", "initially",
  ]);

  const BASE_TYPE_ALIAS = {
    int2: "smallint", int4: "integer", int8: "bigint", int: "integer",
    float4: "real", float8: "double precision", bool: "boolean",
    varchar: "character varying", bpchar: "character", char: "character",
    timestamptz: "timestamp with time zone", timetz: "time with time zone",
    serial4: "serial", serial8: "bigserial", decimal: "numeric",
  };

  function normalizeType(raw) {
    const base = String(raw).toLowerCase().replace(/\(.*$/, "").replace(/\[\s*\]/g, "").trim();
    return BASE_TYPE_ALIAS[base] || base;
  }

  function parseDdlSync(sql, warnings) {
    const graph = createGraph();
    const tokens = tokenize(sql, { keepComments: false });
    const stmts = splitStatements(tokens);
    for (const stmt of stmts) {
      try {
        parseStatement(stmt, graph, warnings);
      } catch (e) {
        if (warnings.length < 200) warnings.push(`语句解析失败：${(e && e.message) || e}`);
      }
    }
    return { graph, statementCount: stmts.length };
  }

  async function parseDdl(sql, onProgress) {
    const warnings = [];
    const graph = createGraph();
    const tokens = tokenize(sql, { keepComments: false });
    const stmts = splitStatements(tokens);
    for (let i = 0; i < stmts.length; i++) {
      try {
        parseStatement(stmts[i], graph, warnings);
      } catch (e) {
        if (warnings.length < 200) warnings.push(`语句 #${i + 1} 解析失败：${(e && e.message) || e}`);
      }
      if ((i & 127) === 127) {
        onProgress && onProgress(i / stmts.length);
        await sleep(0);
      }
    }
    onProgress && onProgress(1);
    return { graph, warnings, statementCount: stmts.length };
  }

  function kw(t) {
    return t && (t.type === T.KEYWORD || t.type === T.IDENT) ? String(t.value ?? t.text).toLowerCase() : null;
  }

  function parseStatement(toks, graph, warnings) {
    const head = kw(toks[0]);
    if (!head) return;
    if (head === "create") return parseCreate(toks, graph, warnings);
    if (head === "alter") return parseAlter(toks, graph, warnings);
    if (head === "comment") return parseComment(toks, graph);
  }

  function parseCreate(toks, graph, warnings) {
    let i = 1;
    // 跳过 OR REPLACE / GLOBAL / TEMP / UNLOGGED / RECURSIVE 等修饰词
    const skip = new Set(["or", "replace", "global", "local", "temp", "temporary", "unlogged", "recursive", "if", "not", "exists", "concurrently"]);
    let unique = false;
    let materialized = false;
    while (i < toks.length) {
      const k = kw(toks[i]);
      if (k === "unique") { unique = true; i++; continue; }
      if (k === "materialized") { materialized = true; i++; continue; }
      if (skip.has(k)) { i++; continue; }
      break;
    }
    const k = kw(toks[i]);
    i++;
    switch (k) {
      case "schema": {
        const qn = readQualified(toks, i);
        if (qn) ensureSchema(graph, qn.name, qn.quoted);
        return;
      }
      case "table":
        return parseCreateTable(toks, i, graph, warnings, "table");
      case "view":
        return parseCreateRelationShell(toks, i, graph, materialized ? "matview" : "view");
      case "index":
        return parseCreateIndex(toks, i, graph, unique);
      case "sequence": {
        const qn = readQualified(toks, i);
        if (!qn) return;
        const s = ensureSchema(graph, qn.schema || "public", qn.schemaQuoted);
        s.sequences[fold(qn.name, qn.quoted)] = { name: qn.name, quoted: qn.quoted, schema: s.name };
        return;
      }
      case "function":
      case "procedure":
        return parseCreateFunction(toks, i, graph, k);
      case "foreign":
        if (kw(toks[i]) === "table") return parseCreateTable(toks, i + 1, graph, warnings, "foreign");
        return;
      default:
        return; // TYPE / EXTENSION / TRIGGER / DOMAIN 等：暂不建模
    }
  }

  function makeRelation(schema, name, quoted, kind) {
    return {
      kind,
      schema: schema.name,
      schemaKey: schema.key,
      name,
      quoted,
      key: fold(name, quoted),
      columns: [],
      columnByKey: Object.create(null),
      pk: [],
      fks: [],
      indexes: [],
      comment: null,
    };
  }

  function parseCreateRelationShell(toks, i, graph, kind) {
    const qn = readQualified(toks, i);
    if (!qn) return;
    const schema = ensureSchema(graph, qn.schema || "public", qn.schemaQuoted);
    const rel = makeRelation(schema, qn.name, qn.quoted, kind);
    // 视图列清单：CREATE VIEW v (a, b) AS ...
    let j = qn.next;
    if (toks[j] && toks[j].text === "(") {
      j++;
      let ord = 1;
      while (toks[j] && toks[j].text !== ")") {
        if (toks[j].type === T.IDENT) {
          addColumn(rel, { name: toks[j].value ?? toks[j].text, quoted: !!toks[j].quoted, type: "", ordinal: ord++ });
        }
        j++;
      }
    }
    schema.relations[rel.key] = rel;
  }

  function addColumn(rel, col) {
    const key = fold(col.name, col.quoted);
    const full = {
      name: col.name,
      quoted: !!col.quoted,
      key,
      type: col.type || "",
      baseType: normalizeType(col.type || ""),
      notNull: !!col.notNull,
      default: col.default || null,
      ordinal: col.ordinal || rel.columns.length + 1,
      pk: !!col.pk,
      comment: null,
    };
    rel.columns.push(full);
    rel.columnByKey[key] = full;
    return full;
  }

  function parseCreateTable(toks, i, graph, warnings, kind) {
    const qn = readQualified(toks, i);
    if (!qn) return;
    const schema = ensureSchema(graph, qn.schema || "public", qn.schemaQuoted);
    const rel = makeRelation(schema, qn.name, qn.quoted, kind);
    schema.relations[rel.key] = rel;

    let j = qn.next;
    // CREATE TABLE x PARTITION OF / OF type / AS SELECT ...：无列清单
    if (!toks[j] || toks[j].text !== "(") return;
    j++;

    let ordinal = 1;
    while (j < toks.length) {
      const t = toks[j];
      if (!t) break;
      if (t.type === T.PUNCT && t.text === ")") break;
      if (t.type === T.PUNCT && t.text === ",") { j++; continue; }

      const k = kw(t);
      if (k === "constraint" || k === "primary" || k === "unique" || k === "foreign" || k === "check" || k === "exclude") {
        j = parseTableConstraint(toks, j, rel);
        continue;
      }
      if (t.type !== T.IDENT) { j++; continue; }

      j = parseColumnDef(toks, j, rel, ordinal++);
    }
  }

  /** 从 i 开始读一个列定义，返回下一个待处理下标（指向 , 或 )） */
  function parseColumnDef(toks, i, rel, ordinal) {
    const nameTok = toks[i];
    const col = {
      name: nameTok.value ?? nameTok.text,
      quoted: !!nameTok.quoted,
      ordinal,
      type: "",
      notNull: false,
      default: null,
      pk: false,
    };
    let j = i + 1;

    // 类型：吃到顶层 , 或 ) 或列约束关键字
    const typeParts = [];
    let depth = 0;
    while (j < toks.length) {
      const t = toks[j];
      if (t.type === T.PUNCT && t.text === "(") { depth++; typeParts.push(t.text); j++; continue; }
      if (t.type === T.PUNCT && t.text === ")") {
        if (depth === 0) break;
        depth--; typeParts.push(t.text); j++; continue;
      }
      if (depth === 0) {
        if (t.type === T.PUNCT && t.text === ",") break;
        if (COL_CONSTRAINT_KW.has(kw(t))) break;
      }
      typeParts.push(t.type === T.IDENT && t.quoted ? quoteIdent(t.value) : t.text);
      j++;
    }
    col.type = typeParts.join(" ").replace(/\s*\(\s*/g, "(").replace(/\s*\)\s*/g, ")").replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();

    // 列约束
    while (j < toks.length) {
      const t = toks[j];
      if (!t) break;
      if (t.type === T.PUNCT && (t.text === "," || t.text === ")") && depth === 0) break;
      const k = kw(t);
      if (k === "not" && kw(toks[j + 1]) === "null") { col.notNull = true; j += 2; continue; }
      if (k === "null") { j++; continue; }
      if (k === "primary" && kw(toks[j + 1]) === "key") { col.pk = true; col.notNull = true; j += 2; continue; }
      if (k === "references") {
        const ref = readQualified(toks, j + 1);
        if (ref) {
          const fk = {
            columns: [fold(col.name, col.quoted)],
            refSchema: ref.schema || rel.schema,
            refTable: ref.name,
            refTableKey: fold(ref.name, ref.quoted),
            refColumns: [],
          };
          let m = ref.next;
          if (toks[m] && toks[m].text === "(") {
            m++;
            while (toks[m] && toks[m].text !== ")") {
              if (toks[m].type === T.IDENT) fk.refColumns.push(fold(toks[m].value ?? toks[m].text, toks[m].quoted));
              m++;
            }
          }
          rel.fks.push(fk);
          j = m;
        }
        j++;
        continue;
      }
      if (k === "default") {
        const parts = [];
        let d = 0;
        j++;
        while (j < toks.length) {
          const dt = toks[j];
          if (dt.type === T.PUNCT && dt.text === "(") d++;
          if (dt.type === T.PUNCT && dt.text === ")") { if (d === 0) break; d--; }
          if (d === 0 && dt.type === T.PUNCT && dt.text === ",") break;
          if (d === 0 && COL_CONSTRAINT_KW.has(kw(dt)) && kw(dt) !== "null" && kw(dt) !== "not") break;
          parts.push(dt.text);
          j++;
        }
        col.default = parts.join(" ").trim() || null;
        continue;
      }
      // 其余约束（CHECK / UNIQUE / GENERATED / COLLATE …）整体跳过括号内容
      if (t.type === T.PUNCT && t.text === "(") {
        let d = 1; j++;
        while (j < toks.length && d > 0) {
          if (toks[j].text === "(") d++;
          else if (toks[j].text === ")") d--;
          j++;
        }
        continue;
      }
      j++;
    }

    const added = addColumn(rel, col);
    if (col.pk) rel.pk.push(added.key);
    return j;
  }

  /** 表级约束，返回下一个待处理下标 */
  function parseTableConstraint(toks, i, rel) {
    let j = i;
    if (kw(toks[j]) === "constraint") j += 2; // CONSTRAINT <name>

    const k = kw(toks[j]);
    const readColList = (m) => {
      const cols = [];
      if (!toks[m] || toks[m].text !== "(") return { cols, next: m };
      m++;
      let d = 1;
      while (m < toks.length && d > 0) {
        const t = toks[m];
        if (t.text === "(") d++;
        else if (t.text === ")") { d--; if (d === 0) { m++; break; } }
        else if (t.type === T.IDENT && d === 1) cols.push(fold(t.value ?? t.text, t.quoted));
        m++;
      }
      return { cols, next: m };
    };

    if (k === "primary" && kw(toks[j + 1]) === "key") {
      const r = readColList(j + 2);
      for (const c of r.cols) {
        if (!rel.pk.includes(c)) rel.pk.push(c);
        const col = rel.columnByKey[c];
        if (col) { col.pk = true; col.notNull = true; }
      }
      j = r.next;
    } else if (k === "unique") {
      const r = readColList(j + 1);
      rel.indexes.push({ name: null, columns: r.cols, unique: true, fromConstraint: true });
      j = r.next;
    } else if (k === "foreign" && kw(toks[j + 1]) === "key") {
      const r = readColList(j + 2);
      let m = r.next;
      if (kw(toks[m]) === "references") {
        const ref = readQualified(toks, m + 1);
        if (ref) {
          const r2 = readColList(ref.next);
          rel.fks.push({
            columns: r.cols,
            refSchema: ref.schema || rel.schema,
            refTable: ref.name,
            refTableKey: fold(ref.name, ref.quoted),
            refColumns: r2.cols,
          });
          m = r2.next;
        }
      }
      j = m;
    } else {
      // CHECK / EXCLUDE：跳过整个括号
      while (j < toks.length && toks[j].text !== "(") {
        if (toks[j].text === "," || toks[j].text === ")") return j;
        j++;
      }
      let d = 0;
      while (j < toks.length) {
        if (toks[j].text === "(") d++;
        else if (toks[j].text === ")") { d--; if (d === 0) { j++; break; } }
        j++;
      }
    }

    // 吃掉尾部修饰（DEFERRABLE / ON DELETE CASCADE …）直到顶层 , 或 )
    let d = 0;
    while (j < toks.length) {
      const t = toks[j];
      if (t.text === "(") d++;
      else if (t.text === ")") { if (d === 0) break; d--; }
      else if (t.text === "," && d === 0) break;
      j++;
    }
    return j;
  }

  function parseCreateIndex(toks, i, graph, unique) {
    let j = i;
    if (kw(toks[j]) === "concurrently") j++;
    let indexName = null;
    if (kw(toks[j]) !== "on") {
      const qn = readQualified(toks, j);
      if (qn) { indexName = qn.name; j = qn.next; }
    }
    if (kw(toks[j]) !== "on") return;
    j++;
    if (kw(toks[j]) === "only") j++;
    const target = readQualified(toks, j);
    if (!target) return;
    j = target.next;
    if (kw(toks[j]) === "using") j += 2;

    const cols = [];
    if (toks[j] && toks[j].text === "(") {
      let d = 1; j++;
      while (j < toks.length && d > 0) {
        const t = toks[j];
        if (t.text === "(") d++;
        else if (t.text === ")") { d--; if (d === 0) { j++; break; } }
        else if (t.type === T.IDENT && d === 1) cols.push(t.value ?? t.text);
        j++;
      }
    }
    const partial = toks.slice(j).some((t) => kw(t) === "where");

    const schema = ensureSchema(graph, target.schema || "public", target.schemaQuoted);
    const rel = schema.relations[fold(target.name, target.quoted)];
    if (rel) rel.indexes.push({ name: indexName, columns: cols, unique: !!unique, partial });
  }

  function parseCreateFunction(toks, i, graph, kind) {
    const qn = readQualified(toks, i);
    if (!qn) return;
    const schema = ensureSchema(graph, qn.schema || "public", qn.schemaQuoted);
    let j = qn.next;

    const args = [];
    if (toks[j] && toks[j].text === "(") {
      let d = 1; j++;
      let cur = [];
      while (j < toks.length && d > 0) {
        const t = toks[j];
        if (t.text === "(") { d++; cur.push(t.text); }
        else if (t.text === ")") { d--; if (d === 0) { j++; break; } cur.push(t.text); }
        else if (t.text === "," && d === 1) { args.push(cur.join(" ").trim()); cur = []; }
        else cur.push(t.type === T.IDENT && t.quoted ? quoteIdent(t.value) : t.text);
        j++;
      }
      if (cur.length) args.push(cur.join(" ").trim());
    }

    let returns = "";
    const rIdx = toks.findIndex((t, idx) => idx >= j && kw(t) === "returns");
    if (rIdx >= 0) {
      const parts = [];
      for (let m = rIdx + 1; m < toks.length && parts.length < 8; m++) {
        const k2 = kw(toks[m]);
        if (k2 === "language" || k2 === "as" || k2 === "stable" || k2 === "immutable" || k2 === "volatile" || k2 === "security") break;
        parts.push(toks[m].text);
      }
      returns = parts.join(" ").replace(/\s+/g, " ").trim();
    }

    const key = fold(qn.name, qn.quoted) + "(" + args.length + ")";
    schema.functions[key] = {
      name: qn.name,
      quoted: qn.quoted,
      schema: schema.name,
      key,
      args,
      returns,
      kind,
    };
  }

  function parseAlter(toks, graph, warnings) {
    if (kw(toks[1]) !== "table") return;
    let i = 2;
    if (kw(toks[i]) === "only") i++;
    if (kw(toks[i]) === "if" && kw(toks[i + 1]) === "exists") i += 2;
    const qn = readQualified(toks, i);
    if (!qn) return;
    const schema = ensureSchema(graph, qn.schema || "public", qn.schemaQuoted);
    const rel = schema.relations[fold(qn.name, qn.quoted)];
    if (!rel) return;
    let j = qn.next;
    while (j < toks.length) {
      const k = kw(toks[j]);
      if (k === "add") {
        const nk = kw(toks[j + 1]);
        if (nk === "constraint" || nk === "primary" || nk === "unique" || nk === "foreign" || nk === "check") {
          j = parseTableConstraint(toks, j + 1, rel);
          continue;
        }
        if (nk === "column") {
          j = parseColumnDef(toks, j + 2, rel, rel.columns.length + 1);
          continue;
        }
      }
      j++;
    }
  }

  function parseComment(toks, graph) {
    if (kw(toks[1]) !== "on") return;
    const kind = kw(toks[2]);
    if (kind !== "table" && kind !== "column" && kind !== "view" && kind !== "materialized") return;
    let i = kind === "materialized" ? 4 : 3;
    const qn = readQualified(toks, i);
    if (!qn) return;
    const isIdx = toks.findIndex((t, idx) => idx >= qn.next && kw(t) === "is");
    if (isIdx < 0) return;
    const strTok = toks[isIdx + 1];
    if (!strTok || strTok.type !== T.STRING) return;
    const text = strTok.text.replace(/^'|'$/g, "").replace(/''/g, "'");

    const p = qn.parts;
    if (kind === "column") {
      if (p.length < 2) return;
      const colPart = p[p.length - 1];
      const tabPart = p[p.length - 2];
      const schPart = p.length >= 3 ? p[p.length - 3] : { name: "public", quoted: false };
      const schema = graph.schemas[fold(schPart.name, schPart.quoted)];
      if (!schema) return;
      const rel = schema.relations[fold(tabPart.name, tabPart.quoted)];
      if (!rel) return;
      const col = rel.columnByKey[fold(colPart.name, colPart.quoted)];
      if (col) col.comment = text;
    } else {
      const namePart = p[p.length - 1];
      const schPart = p.length >= 2 ? p[p.length - 2] : { name: "public", quoted: false };
      const schema = graph.schemas[fold(schPart.name, schPart.quoted)];
      if (!schema) return;
      const rel = schema.relations[fold(namePart.name, namePart.quoted)];
      if (rel) rel.comment = text;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §4  Schema 索引（检索加速 + 隐式关联推断）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 为 graph 建立检索索引。索引挂在 graph.__index 上（不进 IndexedDB 序列化）。
   */
  function buildIndex(graph) {
    const relations = [];
    const relBySearch = new Map();     // 小写名 -> Relation[]
    const colBySearch = new Map();     // 小写列名 -> {rel, col}[]
    const functions = [];
    const schemas = [];

    for (const sk of Object.keys(graph.schemas)) {
      const s = graph.schemas[sk];
      schemas.push(s);
      for (const rk of Object.keys(s.relations)) {
        const rel = s.relations[rk];
        // 反序列化后 columnByKey 会丢失，这里统一重建
        if (!rel.columnByKey) {
          rel.columnByKey = Object.create(null);
          for (const c of rel.columns) rel.columnByKey[c.key] = c;
        }
        relations.push(rel);
        const k = searchKey(rel.name);
        if (!relBySearch.has(k)) relBySearch.set(k, []);
        relBySearch.get(k).push(rel);
        for (const c of rel.columns) {
          const ck = searchKey(c.name);
          if (!colBySearch.has(ck)) colBySearch.set(ck, []);
          colBySearch.get(ck).push({ rel, col: c });
        }
      }
      for (const fk of Object.keys(s.functions)) functions.push(s.functions[fk]);
    }

    // 显式 FK 反向图
    const fkOut = new Map();  // relFullKey -> [{fromCols, to, toCols, implicit}]
    const fkIn = new Map();
    const fullKey = (rel) => rel.schemaKey + "." + rel.key;
    const addEdge = (from, to, fromCols, toCols, implicit) => {
      const e = { from, to, fromCols, toCols, implicit: !!implicit };
      if (!fkOut.has(fullKey(from))) fkOut.set(fullKey(from), []);
      fkOut.get(fullKey(from)).push(e);
      if (!fkIn.has(fullKey(to))) fkIn.set(fullKey(to), []);
      fkIn.get(fullKey(to)).push(e);
    };

    for (const rel of relations) {
      for (const fk of rel.fks) {
        const targetSchema = graph.schemas[searchKey(fk.refSchema)] || graph.schemas[rel.schemaKey];
        const target = targetSchema && targetSchema.relations[fk.refTableKey];
        if (target) addEdge(rel, target, fk.columns, fk.refColumns.length ? fk.refColumns : target.pk, false);
      }
    }

    // 命名约定隐式关联：列名（或去掉 Id/_id 后缀）与某张表同名，且该表有单列主键
    for (const rel of relations) {
      for (const c of rel.columns) {
        const raw = c.name;
        const candidates = [raw, raw.replace(/(_?[Ii][Dd])$/, "")].filter((x) => x && x.length > 2);
        for (const cand of candidates) {
          const hits = relBySearch.get(searchKey(cand));
          if (!hits) continue;
          for (const target of hits) {
            if (target === rel) continue;
            if (target.pk.length !== 1) continue;
            const alreadyExplicit = rel.fks.some(
              (f) => f.refTableKey === target.key && f.columns.includes(c.key)
            );
            if (alreadyExplicit) continue;
            addEdge(rel, target, [c.key], target.pk, true);
          }
          break; // 命中一个候选写法即可
        }
      }
    }

    // 公共列（几乎每张表都有的审计字段）降权
    const colFreq = new Map();
    for (const [k, arr] of colBySearch) colFreq.set(k, arr.length);
    const commonThreshold = Math.max(8, Math.floor(relations.length * 0.6));

    graph.__index = {
      relations,
      relBySearch,
      colBySearch,
      functions,
      schemas,
      fkOut,
      fkIn,
      fullKey,
      colFreq,
      commonThreshold,
      stats: {
        schemaCount: schemas.length,
        relationCount: relations.length,
        columnCount: relations.reduce((a, r) => a + r.columns.length, 0),
        functionCount: functions.length,
        fkCount: relations.reduce((a, r) => a + r.fks.length, 0),
        indexCount: relations.reduce((a, r) => a + r.indexes.length, 0),
      },
    };
    return graph.__index;
  }

  const idx = (graph) => graph && (graph.__index || buildIndex(graph));

  /**
   * 按 PostgreSQL 语义解析关系名。
   * @returns {{rel:Relation|null, caseMismatch:Relation|null, ambiguous:boolean}}
   */
  function resolveRelation(graph, name, quoted, schemaName) {
    const ix = idx(graph);
    const hits = ix.relBySearch.get(searchKey(name)) || [];
    const scoped = schemaName
      ? hits.filter((r) => searchKey(r.schema) === searchKey(schemaName))
      : hits;
    if (!scoped.length) return { rel: null, caseMismatch: null, ambiguous: false };

    const wanted = fold(name, quoted);
    const exact = scoped.filter((r) => fold(r.name, r.quoted) === wanted || r.name === name);
    if (exact.length) return { rel: exact[0], caseMismatch: null, ambiguous: exact.length > 1 };
    // 大小写/引号不匹配：PostgreSQL 实际会报错，但我们知道用户想要哪张表
    return { rel: null, caseMismatch: scoped[0], ambiguous: scoped.length > 1 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §5  存储层
  // ═══════════════════════════════════════════════════════════════════════════

  let currentConfig = { ...DEFAULT_CONFIG };

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const saved = JSON.parse(raw) || {};
        currentConfig = { ...DEFAULT_CONFIG, ...saved };
        // v1 → v2：实时诊断改为默认关闭。旧配置里没有 configVersion 字段，
        // 说明是这次改动之前存下的，因此强制套用一次新默认值；
        // 之后用户在面板里的选择会连同 configVersion 一起存下来，不再被覆盖。
        if (!saved.configVersion || saved.configVersion < CONFIG_VERSION) {
          currentConfig.diagnosticsEnabled = DEFAULT_CONFIG.diagnosticsEnabled;
          saveConfig({ configVersion: CONFIG_VERSION });
        }
      }
    } catch { /* 用默认值 */ }
    return currentConfig;
  }

  function saveConfig(patch) {
    currentConfig = { ...currentConfig, ...patch };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(currentConfig));
    } catch { /* 隐私模式下忽略 */ }
    return currentConfig;
  }

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ST_SNAPSHOTS)) {
          db.createObjectStore(ST_SNAPSHOTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(ST_GRAPHS)) {
          db.createObjectStore(ST_GRAPHS, { keyPath: "snapshotId" });
        }
        if (!db.objectStoreNames.contains(ST_USAGE)) {
          db.createObjectStore(ST_USAGE, { keyPath: ["snapshotId", "symbol"] })
            .createIndex("bySnapshot", "snapshotId");
        }
        if (!db.objectStoreNames.contains(ST_HISTORY)) {
          const s = db.createObjectStore(ST_HISTORY, { keyPath: "id", autoIncrement: true });
          s.createIndex("byTime", "executedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbRun(stores, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try {
        result = fn(...stores.map((s) => tx.objectStore(s)));
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => {
        if (result && typeof result.then === "function") result.then(resolve, reject);
        else if (result && "result" in result) resolve(result.result);
        else resolve(result);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const idbGet = (store, key) => idbRun([store], "readonly", (s) => s.get(key));
  const idbAll = (store) => idbRun([store], "readonly", (s) => s.getAll());
  const idbPut = (store, val) => idbRun([store], "readwrite", (s) => s.put(val));
  const idbDel = (store, key) => idbRun([store], "readwrite", (s) => s.delete(key));

  // ═══════════════════════════════════════════════════════════════════════════
  // §6  语句上下文分析
  // ═══════════════════════════════════════════════════════════════════════════

  const CTX = {
    RELATION: "relation",   // FROM / JOIN / UPDATE / INSERT INTO / TABLE 之后
    COLUMN: "column",       // SELECT / WHERE / ON / SET / GROUP BY / ORDER BY 之后
    QUALIFIED: "qualified", // xxx. 之后
    ANY: "any",
  };

  const CLAUSE_KEYWORDS = new Set([
    "select", "from", "where", "join", "on", "group", "order", "having", "set",
    "into", "update", "delete", "insert", "values", "returning", "using", "limit",
    "offset", "with", "as", "and", "or", "not", "case", "when", "then", "else", "end",
  ]);

  const RELATION_INTRO = new Set(["from", "join", "update", "into", "table", "only"]);

  /**
   * 分析光标处的补全上下文。
   * @param {string} docText 全文，或调用方已切好的窗口文本
   * @param {number} pos 光标在**文档**中的绝对位置
   * @param {object} graph
   * @param {number} [baseOverride] 当 docText 是窗口时，窗口起点在文档中的绝对位置。
   *   传了它就不再自己切片 —— 配合 CM6 的 sliceString 可省掉 doc.toString() 的全量拼接。
   * @returns {null | {
   *   kind: string, from: number, replaceFrom: number, hadOpenQuote: boolean,
   *   typed: string, qualifier: {name:string,quoted:boolean}|null,
   *   scope: Map<string, Relation>, scopeList: Relation[], clause: string|null,
   *   afterJoinOn: boolean, insertColumns: Relation|null, stmtFrom: number, stmtTo: number
   * }}
   */
  function analyzeContext(docText, pos, graph, baseOverride) {
    // 大文档只分析光标附近，避免每次按键都全量分词
    let base = 0;
    let text = docText;
    if (typeof baseOverride === "number") {
      base = baseOverride;
    } else if (docText.length > ANALYZE_WINDOW_THRESHOLD) {
      base = Math.max(0, pos - ANALYZE_WINDOW_BACK);
      text = docText.slice(base, Math.min(docText.length, pos + ANALYZE_WINDOW_FWD));
    }
    const localPos = pos - base;

    const tokens = tokenize(text, { keepComments: true });

    // 光标落在注释/字符串里就不补全
    for (const t of tokens) {
      if (t.from < localPos && localPos <= t.to) {
        if (t.type === T.COMMENT) return null;
        if (t.type === T.STRING) return null;
      }
    }

    const code = tokens.filter((t) => t.type !== T.COMMENT);

    // 当前语句范围
    let start = 0;
    let end = code.length;
    for (let i = 0; i < code.length; i++) {
      const t = code[i];
      if (t.type === T.PUNCT && t.text === ";") {
        if (t.to <= localPos) start = i + 1;
        else { end = i; break; }
      }
    }
    const stmt = code.slice(start, end);
    if (!stmt.length && !docText.slice(0, pos).trim()) {
      // 空文档：给关键字
    }

    // 光标前最后一个 token 的下标（stmt 内）
    let cursorIdx = -1;
    for (let i = 0; i < stmt.length; i++) {
      if (stmt[i].from < localPos) cursorIdx = i;
      else break;
    }

    // 正在输入的前缀
    let typed = "";
    let replaceFrom = localPos;
    let from = localPos;
    let hadOpenQuote = false;
    let prefixTokenIdx = -1;

    const last = cursorIdx >= 0 ? stmt[cursorIdx] : null;
    if (last && last.to >= localPos && (last.type === T.IDENT || last.type === T.KEYWORD)) {
      prefixTokenIdx = cursorIdx;
      replaceFrom = last.from;
      if (last.quoted) {
        hadOpenQuote = true;
        from = last.from + 1;
        typed = text.slice(from, localPos);
      } else {
        from = last.from;
        typed = text.slice(from, localPos);
      }
    }

    // 限定符：前缀之前是否为  ident .
    let qualifier = null;
    const beforeIdx = prefixTokenIdx >= 0 ? prefixTokenIdx - 1 : cursorIdx;
    const dotTok = beforeIdx >= 0 ? stmt[beforeIdx] : null;
    if (dotTok && dotTok.type === T.PUNCT && dotTok.text === "." && dotTok.to <= localPos) {
      const q = stmt[beforeIdx - 1];
      if (q && (q.type === T.IDENT || q.type === T.KEYWORD)) {
        qualifier = { name: q.value ?? q.text, quoted: !!q.quoted };
      }
      if (prefixTokenIdx < 0) { replaceFrom = localPos; from = localPos; }
    }

    // 收集 FROM / JOIN / UPDATE / INTO 引入的关系与别名
    const scope = new Map();
    const scopeList = [];
    if (graph) collectScope(stmt, graph, scope, scopeList);

    // 当前子句
    let clause = null;
    for (let i = cursorIdx; i >= 0; i--) {
      const k = kw(stmt[i]);
      if (k && CLAUSE_KEYWORDS.has(k) && i !== prefixTokenIdx) { clause = k; break; }
    }
    // "GROUP BY" / "ORDER BY" 归一
    if (clause === "by") {
      for (let i = cursorIdx - 1; i >= 0; i--) {
        const k = kw(stmt[i]);
        if (k === "group" || k === "order" || k === "partition") { clause = k; break; }
      }
    }

    // 判定种类
    let kind = CTX.ANY;
    if (qualifier) {
      kind = CTX.QUALIFIED;
    } else {
      // 前缀之前紧邻的实义 token
      let prevK = null;
      for (let i = (prefixTokenIdx >= 0 ? prefixTokenIdx : cursorIdx + 1) - 1; i >= 0; i--) {
        const t = stmt[i];
        if (t.type === T.PUNCT && (t.text === "," || t.text === "(")) continue;
        prevK = kw(t);
        break;
      }
      if (prevK && RELATION_INTRO.has(prevK)) kind = CTX.RELATION;
      else if (clause && ["select", "where", "on", "set", "group", "order", "having", "and", "or", "returning", "when", "then", "case", "values", "using"].includes(clause)) kind = CTX.COLUMN;
      else if (clause && RELATION_INTRO.has(clause)) kind = CTX.RELATION;
    }

    // INSERT INTO t ( <这里> )
    let insertColumns = null;
    if (graph) {
      const insIdx = stmt.findIndex((t) => kw(t) === "insert");
      if (insIdx >= 0) {
        const intoIdx = stmt.findIndex((t, i) => i > insIdx && kw(t) === "into");
        if (intoIdx >= 0) {
          const qn = readQualified(stmt, intoIdx + 1);
          if (qn && stmt[qn.next] && stmt[qn.next].text === "(" && stmt[qn.next].to <= localPos) {
            const closeIdx = findMatchingParen(stmt, qn.next);
            if (closeIdx < 0 || stmt[closeIdx].from >= localPos) {
              const r = resolveRelation(graph, qn.name, qn.quoted, qn.schema);
              insertColumns = r.rel || r.caseMismatch;
              if (insertColumns) kind = CTX.COLUMN;
            }
          }
        }
      }
    }

    // JOIN x ON <这里>
    const afterJoinOn = clause === "on";

    return {
      kind,
      clause,
      from: from + base,
      replaceFrom: replaceFrom + base,
      hadOpenQuote,
      typed,
      qualifier,
      scope,
      scopeList,
      afterJoinOn,
      insertColumns,
      stmtFrom: (stmt[0] ? stmt[0].from : 0) + base,
      stmtTo: (stmt.length ? stmt[stmt.length - 1].to : 0) + base,
      stmtTokens: stmt,
      tokenBase: base,
    };
  }

  function findMatchingParen(toks, openIdx) {
    let d = 0;
    for (let i = openIdx; i < toks.length; i++) {
      if (toks[i].text === "(") d++;
      else if (toks[i].text === ")") { d--; if (d === 0) return i; }
    }
    return -1;
  }

  /** 扫描语句里的 FROM / JOIN / UPDATE / INTO，登记关系与别名 */
  function collectScope(stmt, graph, scope, scopeList) {
    const ALIAS_STOP = new Set([
      "on", "where", "join", "inner", "left", "right", "full", "cross", "group", "order",
      "having", "limit", "offset", "union", "except", "intersect", "set", "values",
      "returning", "using", "and", "or", "as", "natural", "lateral", "for", "window", "with",
    ]);
    for (let i = 0; i < stmt.length; i++) {
      const k = kw(stmt[i]);
      if (!RELATION_INTRO.has(k) || k === "only") continue;
      let j = i + 1;
      for (;;) {
        if (kw(stmt[j]) === "only") j++;
        if (stmt[j] && stmt[j].text === "(") break; // 子查询：跳过
        const qn = readQualified(stmt, j);
        if (!qn) break;
        const res = resolveRelation(graph, qn.name, qn.quoted, qn.schema);
        const rel = res.rel || res.caseMismatch;
        j = qn.next;

        let alias = null;
        if (kw(stmt[j]) === "as") j++;
        const at = stmt[j];
        if (at && (at.type === T.IDENT || (at.type === T.KEYWORD && !ALIAS_STOP.has(kw(at))))) {
          if (!ALIAS_STOP.has(kw(at))) { alias = at.value ?? at.text; j++; }
        }

        if (rel) {
          if (!scopeList.includes(rel)) scopeList.push(rel);
          scope.set(searchKey(alias || rel.name), rel);
          if (alias) scope.set(searchKey(rel.name), rel);
        }
        if (stmt[j] && stmt[j].text === ",") { j++; continue; }
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §7  候选生成与排序
  // ═══════════════════════════════════════════════════════════════════════════

  const SQL_KEYWORD_SUGGESTIONS = [
    "SELECT", "FROM", "WHERE", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "ON",
    "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT INTO", "VALUES",
    "UPDATE", "SET", "DELETE FROM", "RETURNING", "DISTINCT", "COUNT(*)", "WITH",
    "UNION ALL", "CASE WHEN", "IS NULL", "IS NOT NULL", "COALESCE", "EXISTS",
    // 裸关键字必须与组合关键字并列存在：CM6 模糊匹配下，输入 join/on/as 等短词
    // 会命中 "INNER JOIN"/"CASE WHEN" 等长候选，回车就插入了意料之外的关键字
    "AS", "AND", "OR", "NOT", "IN", "LIKE",
  ];

  /**
   * 生成补全候选（未经 CM6 过滤的完整集合，交给 CM6 做模糊匹配与高亮）。
   */
  function buildCandidates(info, graph, usage) {
    const ix = idx(graph);
    const out = [];
    const cfg = currentConfig;
    const bump = (key) => (usage && usage.get(key)) || 0;

    const pushRelation = (rel, boost, why) => {
      const key = "rel:" + ix.fullKey(rel);
      out.push({
        label: rel.name,
        kind: "class",
        detail: `${rel.kind === "table" ? "表" : rel.kind === "view" ? "视图" : rel.kind === "matview" ? "物化视图" : "外部表"} · ${rel.columns.length} 列${rel.schema !== "public" ? " · " + rel.schema : ""}`,
        insert: (rel.schema !== "public" && !info.qualifier ? renderIdent(rel.schema) + "." : "") + renderIdent(rel.name),
        boost: boost + Math.min(20, bump(key) * 2) + (why === "scope" ? 15 : 0),
        usageKey: key,
        docKind: "relation",
        target: rel,
      });
    };

    const pushColumn = (rel, col, boost, alias) => {
      const key = "col:" + ix.fullKey(rel) + "." + col.key;
      const common = (ix.colFreq.get(searchKey(col.name)) || 0) >= ix.commonThreshold;
      const flags = [];
      if (col.pk) flags.push("PK");
      if (col.notNull) flags.push("NOT NULL");
      const fkTo = rel.fks.find((f) => f.columns.includes(col.key));
      if (fkTo) flags.push("FK→" + fkTo.refTable);
      out.push({
        label: col.name,
        kind: col.pk ? "constant" : "property",
        detail: `${col.type || "?"}${flags.length ? " · " + flags.join(" ") : ""} · ${rel.name}`,
        insert: (alias ? alias + "." : "") + renderIdent(col.name),
        boost: boost - (common ? 22 : 0) + (col.pk ? 8 : 0) + Math.min(20, bump(key) * 2),
        usageKey: key,
        docKind: "column",
        target: { rel, col },
      });
    };

    // ── xxx.  ────────────────────────────────────────────────────────────
    if (info.kind === CTX.QUALIFIED && info.qualifier) {
      const qname = searchKey(info.qualifier.name);
      const rel = info.scope.get(qname);
      if (rel) {
        for (const c of rel.columns) pushColumn(rel, c, 90 - c.ordinal * 0.01, null);
        out.push({ label: "*", kind: "keyword", detail: "全部列", insert: "*", boost: 50, docKind: "star" });
        // 展开为显式列清单
        if (rel.columns.length <= 60) {
          out.push({
            label: "*（展开为列清单）",
            kind: "keyword",
            detail: `${rel.columns.length} 列`,
            insert: rel.columns.map((c) => renderIdent(c.name)).join(", "),
            boost: 40,
            docKind: "star",
          });
        }
        return finish(out, cfg);
      }
      // 限定符是 schema 名
      const schema = graph.schemas[fold(info.qualifier.name, info.qualifier.quoted)]
        || graph.schemas[searchKey(info.qualifier.name)];
      if (schema) {
        for (const rk of Object.keys(schema.relations)) pushRelation(schema.relations[rk], 80, "schema");
        for (const fk of Object.keys(schema.functions)) pushFunction(out, schema.functions[fk], 60, bump);
        return finish(out, cfg);
      }
      // 限定符是未在 FROM 里出现的表名
      const res = resolveRelation(graph, info.qualifier.name, info.qualifier.quoted, null);
      const guess = res.rel || res.caseMismatch;
      if (guess) {
        for (const c of guess.columns) pushColumn(guess, c, 85 - c.ordinal * 0.01, null);
        return finish(out, cfg);
      }
      return finish(out, cfg);
    }

    // ── INSERT INTO t ( … ) ──────────────────────────────────────────────
    if (info.insertColumns) {
      for (const c of info.insertColumns.columns) {
        pushColumn(info.insertColumns, c, 95 - c.ordinal * 0.01, null);
      }
      return finish(out, cfg);
    }

    // ── JOIN … ON  →  优先给 FK 连接条件 ─────────────────────────────────
    let joinConditionCount = 0;
    if (info.afterJoinOn && info.scopeList.length >= 2) {
      const right = info.scopeList[info.scopeList.length - 1];
      for (const left of info.scopeList.slice(0, -1)) {
        for (const e of joinEdges(ix, left, right)) {
          const lAlias = aliasOf(info.scope, e.from) || renderIdent(e.from.name);
          const rAlias = aliasOf(info.scope, e.to) || renderIdent(e.to.name);
          const cond = e.fromCols
            .map((c, n) => `${lAlias}.${renderIdent(colName(e.from, c))} = ${rAlias}.${renderIdent(colName(e.to, e.toCols[n] || e.toCols[0]))}`)
            .join(" AND ");
          out.push({
            label: cond,
            kind: "text",
            detail: e.implicit ? "推断关联（命名约定）" : "外键关联",
            insert: cond,
            boost: e.implicit ? 97 : 99,
            docKind: "join",
          });
          joinConditionCount++;
        }
      }
    }

    // ── 列 ───────────────────────────────────────────────────────────────
    if (info.kind === CTX.COLUMN || info.kind === CTX.ANY) {
      // ON 子句里已经给出连接条件时，普通列整体降权，别把答案挤下去
      const colBase = joinConditionCount ? 70 : 88;
      const multi = info.scopeList.length > 1;
      for (const rel of info.scopeList) {
        const alias = multi ? aliasOf(info.scope, rel) : null;
        for (const c of rel.columns) pushColumn(rel, c, colBase - c.ordinal * 0.01, alias);
      }
      if (!info.scopeList.length) {
        // 还没写 FROM：给全库列名（按出现次数收敛，避免刷屏）
        for (const [, arr] of ix.colBySearch) {
          if (arr.length > 3) continue;
          for (const { rel, col } of arr.slice(0, 2)) pushColumn(rel, col, 30);
        }
      }
    }

    // ── 关系 ─────────────────────────────────────────────────────────────
    if (info.kind === CTX.RELATION || info.kind === CTX.ANY || info.kind === CTX.COLUMN) {
      const relBoost = info.kind === CTX.RELATION ? 95 : 45;
      for (const rel of ix.relations) {
        pushRelation(rel, relBoost, info.scopeList.includes(rel) ? "scope" : "");
      }
      if (info.kind === CTX.RELATION) {
        for (const s of ix.schemas) {
          if (s.key === "public") continue;
          out.push({
            label: s.name,
            kind: "namespace",
            detail: `schema · ${Object.keys(s.relations).length} 个对象`,
            insert: renderIdent(s.name),
            boost: 70,
            docKind: "schema",
            target: s,
          });
        }
      }
    }

    // ── 函数 ─────────────────────────────────────────────────────────────
    if (info.kind === CTX.COLUMN || info.kind === CTX.ANY) {
      for (const f of ix.functions) pushFunction(out, f, 40, bump);
    }

    // ── 关键字 ───────────────────────────────────────────────────────────
    // 按子句上下文动态加权：SELECT 列表之后最常写 FROM（列 88 / 函数 40，固定 20 会沉底）；
    // FROM 之后常接 JOIN / WHERE
    const kwBoost = (k) => {
      if (info.clause === "select" && k === "FROM") return 92;
      if (info.clause === "from" && (k === "JOIN" || k === "INNER JOIN" || k === "LEFT JOIN" || k === "WHERE")) return 92;
      return 20;
    };
    // CM6 匹配分对大小写折叠罚 -200（例：输入 fro 时 label "FROM" 得 -304，而列
    // from_stage 前缀匹配得 -100，boost 差无法弥补）。因此关键字 label 跟随用户
    // 输入的大小写（小写输入 → 小写 label → 前缀匹配），displayLabel 固定大写显示。
    const kwLower = info.typed !== "" && !/[A-Z]/.test(info.typed);
    for (const k of SQL_KEYWORD_SUGGESTIONS) {
      out.push({
        label: kwLower ? k.toLowerCase() : k,
        displayLabel: k,
        kind: "keyword", detail: "关键字", insert: k, boost: kwBoost(k), docKind: "keyword",
      });
    }

    return finish(out, cfg);
  }

  function pushFunction(out, f, boost, bump) {
    const key = "fn:" + f.schema + "." + f.key;
    out.push({
      label: f.name,
      kind: "function",
      detail: `${f.kind === "procedure" ? "过程" : "函数"}(${f.args.length})${f.returns ? " → " + f.returns : ""}`,
      insert: (f.schema !== "public" ? renderIdent(f.schema) + "." : "") + renderIdent(f.name) + "()",
      cursorOffset: -1,
      boost: boost + Math.min(15, (bump ? bump(key) : 0) * 2),
      usageKey: key,
      docKind: "function",
      target: f,
    });
  }

  function colName(rel, key) {
    const c = rel.columnByKey && rel.columnByKey[key];
    return c ? c.name : key;
  }

  function aliasOf(scope, rel) {
    for (const [alias, r] of scope) {
      if (r === rel && searchKey(rel.name) !== alias) return alias;
    }
    return null;
  }

  function joinEdges(ix, a, b) {
    const res = [];
    for (const e of ix.fkOut.get(ix.fullKey(a)) || []) if (e.to === b) res.push(e);
    for (const e of ix.fkOut.get(ix.fullKey(b)) || []) if (e.to === a) res.push({ ...e, from: e.from, to: e.to });
    return res;
  }

  function finish(list, cfg) {
    list.sort((x, y) => y.boost - x.boost || x.label.localeCompare(y.label));
    return list.length > cfg.maxCandidates * 40 ? list.slice(0, cfg.maxCandidates * 40) : list;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §8  诊断
  // ═══════════════════════════════════════════════════════════════════════════

  const SEV = { ERROR: "error", WARNING: "warning", INFO: "info" };

  /**
   * @returns {{from:number,to:number,severity:string,message:string}[]}
   */
  function runDiagnostics(docText, graph) {
    const cfg = currentConfig;
    if (!cfg.diagnosticsEnabled || !graph) return [];
    if (docText.length > MAX_DIAG_DOC_CHARS) return [];

    const out = [];
    const tokens = tokenize(docText, { keepComments: false });
    const stmts = splitStatements(tokens);

    for (const stmt of stmts) {
      if (!stmt.length) continue;
      const head = kw(stmt[0]);
      if (!["select", "insert", "update", "delete", "with", "merge"].includes(head)) continue;

      const scope = new Map();
      const scopeList = [];
      collectScope(stmt, graph, scope, scopeList);

      // 未知表 / 引号缺失
      if (cfg.diagUnknownObject || cfg.diagQuoteRequired) {
        for (let i = 0; i < stmt.length; i++) {
          const k = kw(stmt[i]);
          if (!RELATION_INTRO.has(k) || k === "only") continue;
          let j = i + 1;
          if (kw(stmt[j]) === "only") j++;
          if (stmt[j] && stmt[j].text === "(") continue;
          const qn = readQualified(stmt, j);
          if (!qn) continue;
          const nameTok = stmt[qn.next - 1];
          const res = resolveRelation(graph, qn.name, qn.quoted, qn.schema);
          if (res.rel) continue;
          if (res.caseMismatch) {
            if (cfg.diagQuoteRequired) {
              out.push({
                from: nameTok.from,
                to: nameTok.to,
                severity: SEV.ERROR,
                message: `标识符大小写不符：数据库里是 ${quoteIdent(res.caseMismatch.name)}。PostgreSQL 会把未加引号的名字折叠成小写，请写成 ${quoteIdent(res.caseMismatch.name)}。`,
                fix: quoteIdent(res.caseMismatch.name),
              });
            }
          } else if (cfg.diagUnknownObject) {
            out.push({
              from: nameTok.from,
              to: nameTok.to,
              severity: SEV.WARNING,
              message: `快照中不存在表/视图 ${qn.name}`,
            });
          }
        }
      }

      // 未知列（仅检查 alias.col 形式，避免误报）
      if (cfg.diagUnknownObject && scope.size) {
        for (let i = 0; i + 2 < stmt.length; i++) {
          const a = stmt[i], dot = stmt[i + 1], c = stmt[i + 2];
          if (a.type !== T.IDENT || dot.text !== "." || c.type !== T.IDENT) continue;
          if (stmt[i - 1] && stmt[i - 1].text === ".") continue; // 三段式 schema.tbl.col
          const rel = scope.get(searchKey(a.value ?? a.text));
          if (!rel) continue;
          const wanted = fold(c.value ?? c.text, c.quoted);
          if (rel.columnByKey[wanted]) continue;
          const ci = rel.columns.find((x) => searchKey(x.name) === searchKey(c.value ?? c.text));
          if (ci) {
            if (cfg.diagQuoteRequired) {
              out.push({
                from: c.from, to: c.to, severity: SEV.ERROR,
                message: `列名大小写不符：应为 ${quoteIdent(ci.name)}`,
                fix: quoteIdent(ci.name),
              });
            }
          } else {
            out.push({
              from: c.from, to: c.to, severity: SEV.WARNING,
              message: `表 ${rel.name} 没有列 ${c.value ?? c.text}`,
            });
          }
        }
      }

      // UPDATE / DELETE 缺 WHERE
      if (cfg.diagMissingWhere && (head === "update" || head === "delete")) {
        const hasWhere = stmt.some((t) => kw(t) === "where");
        if (!hasWhere) {
          out.push({
            from: stmt[0].from, to: stmt[0].to, severity: SEV.WARNING,
            message: `${head.toUpperCase()} 没有 WHERE 子句，将影响整表所有行`,
          });
        }
      }

      // SELECT *
      if (cfg.diagSelectStar && head === "select") {
        const star = stmt.find((t, i) => t.text === "*" && kw(stmt[i - 1]) === "select");
        if (star) {
          out.push({ from: star.from, to: star.to, severity: SEV.INFO, message: "SELECT * 会取回全部列，建议显式列出所需列" });
        }
      }
    }

    return out.sort((a, b) => a.from - b.from);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §9  智能粘贴
  // ═══════════════════════════════════════════════════════════════════════════

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const NUM_RE = /^-?\d+(\.\d+)?$/;

  function sqlLiteral(v) {
    const s = String(v).trim();
    if (NUM_RE.test(s)) return s;
    if (/^(true|false|null)$/i.test(s)) return s.toUpperCase();
    return "'" + s.replace(/'/g, "''") + "'";
  }

  /**
   * 决定粘贴内容如何转换。返回 null 表示按原样粘贴。
   */
  function transformPaste(clip, docText, pos) {
    if (!currentConfig.smartPasteEnabled) return null;
    const raw = String(clip);
    if (!raw.trim()) return null;
    // 已经像 SQL 就别动
    if (/\b(select|insert|update|delete|create|alter|drop|with)\b/i.test(raw)) return null;
    // 已经是 IN (...) / 元组列表，不要再拆开加引号
    if (/^\s*\([\s\S]*\)\s*$/.test(raw)) return null;

    const before = docText.slice(Math.max(0, pos - 400), pos);
    // 光标是否在 IN ( … ) 里
    const inList = /\b(in|any|values)\s*\(\s*[^)]*$/i.test(before);

    const items = raw
      .split(/[\r\n\t]+|,(?=(?:[^']*'[^']*')*[^']*$)/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0);

    if (items.length > 1) {
      // 多行/多值 → 引号列表：仅当光标确在 IN ( / VALUES ( 列表里才转换，
      // 其他位置粘贴多行内容一律原样（此前无条件转换会导致意外加引号）
      if (!inList) return null;
      const joined = items.map(sqlLiteral).join(", ");
      return { insert: joined, reason: `${items.length} 个值` };
    }

    const one = items[0];
    if (!one) return null;
    if (NUM_RE.test(one)) return null;

    // 单值：紧跟比较运算符 / LIKE 时自动加引号；逗号 / IN( / VALUES( 等列表
    // 上下文仅在 inList（光标确在括号列表内）时触发——避免 SELECT a, 后
    // 粘贴列名被强加引号
    const opLiteral = /(=|<>|!=|<|>|<=|>=|\blike\b|\bilike\b)\s*$/i.test(before);
    const wantsLiteral = opLiteral || (inList && /[(,]\s*$/.test(before));
    const alreadyQuoted = /'\s*$/.test(before);
    if (!wantsLiteral || alreadyQuoted) return null;
    if (UUID_RE.test(one) || DATE_RE.test(one) || /^[^'"]+$/.test(one)) {
      return { insert: sqlLiteral(one), reason: UUID_RE.test(one) ? "uuid" : DATE_RE.test(one) ? "日期" : "文本" };
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §10  CM6 模块桥（每个 window 一份）
  // ═══════════════════════════════════════════════════════════════════════════

  /** 用官方通道拿到真正的 __webpack_require__（禁止自己重放 factory） */
  function grabWebpackRequire(win) {
    try {
      const chunk = win.webpackChunk;
      if (!Array.isArray(chunk) || typeof chunk.push !== "function") return null;
      let req = null;
      const id = "__pg4_" + Math.random().toString(36).slice(2, 10);
      chunk.push([[id], { [id]: () => {} }, (r) => { req = r; }]);
      return req && typeof req.m === "object" ? req : null;
    } catch (e) {
      warn("grabWebpackRequire failed:", e && e.message);
      return null;
    }
  }

  /**
   * 定位 pgAdmin 自己那份 CodeMirror 模块。
   * 模块是 CommonJS 风格（`t.EditorView=...`），导出名未混淆，可直接按 `.Name=` 扫源码。
   * 每个包可能有多份（另一份被混淆），用活编辑器实例做身份校验挑对的那份。
   */
  function locateCm6Modules(req, view) {
    const MARKERS = {
      state: ".StateEffect=",
      view: ".hoverTooltip=",
      autocomplete: ".autocompletion=",
      language: ".syntaxTree=",
      sql: ".PostgreSQL=",
    };
    const found = { state: [], view: [], autocomplete: [], language: [], sql: [] };

    const t0 = performance.now();
    for (const id of Object.keys(req.m)) {
      let src;
      try { src = String(req.m[id]); } catch { continue; }
      for (const kind of Object.keys(MARKERS)) {
        if (src.includes(MARKERS[kind])) found[kind].push(id);
      }
    }
    dbg(`module scan ${Object.keys(req.m).length} modules in ${Math.round(performance.now() - t0)}ms`, found);

    const pick = (ids, validate) => {
      for (const id of ids) {
        let exp;
        try { exp = req(id); } catch { continue; }
        if (!exp) continue;
        try { if (validate(exp)) return exp; } catch { /* 下一个 */ }
      }
      return null;
    };

    // StateEffect 是 class（typeof === "function"），appendConfig 是它的静态 Facet 入口
    const state = pick(found.state, (e) =>
      typeof e.StateEffect === "function" && !!e.StateEffect.appendConfig
      && typeof e.StateField === "function" && view.state instanceof e.EditorState);
    const viewMod = pick(found.view, (e) => typeof e.EditorView === "function" && view instanceof e.EditorView);
    const autocomplete = pick(found.autocomplete, (e) => typeof e.autocompletion === "function" && typeof e.startCompletion === "function");
    const language = pick(found.language, (e) => typeof e.syntaxTree === "function");
    const sql = pick(found.sql, (e) => !!e.PostgreSQL);

    if (!state || !viewMod || !autocomplete) {
      warn("CodeMirror 模块定位失败：", {
        state: !!state, view: !!viewMod, autocomplete: !!autocomplete,
        candidates: found,
      });
      return null;
    }
    return { state, view: viewMod, autocomplete, language, sql, req };
  }

  /**
   * 取出 completionConfig 这个 Facet。
   * autocompletion({activateOnTyping:true}) 返回的扩展数组里，
   * 带 `.facet` 且 value 含 activateOnTyping 的那一项就是 completionConfig.of(config)。
   */
  function findCompletionConfigFacet(A) {
    const flat = [];
    const walk = (e, d) => {
      if (d > 5 || e == null) return;
      if (Array.isArray(e)) { for (const x of e) walk(x, d + 1); return; }
      flat.push(e);
    };
    walk(A.autocompletion({ activateOnTyping: true }), 0);
    const hit = flat.find((e) => e && e.facet && e.value && typeof e.value === "object" && "activateOnTyping" in e.value);
    return hit ? hit.facet : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §11  编辑器接管
  // ═══════════════════════════════════════════════════════════════════════════

  /** Ctrl + ` ：切换离线补全开关（编辑器内经 domEventHandlers，页面其他位置经顶层 document） */
  function isToggleCompletionKey(ev) {
    return !ev.repeat && ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey && ev.key === "`";
  }

  function toggleCompletion(core, M, view) {
    if (!core || core.disposed) return;
    const next = !currentConfig.completionEnabled;
    core.setConfig({ completionEnabled: next });
    try { if (!next && M && view) M.autocomplete.closeCompletion(view); } catch { /* ignore */ }
    core.toast(next ? "补全已开启（Ctrl + `）" : "补全已关闭（Ctrl + `）");
  }

  const BASE_THEME_SPEC = {
    ".pg4-diag-error": {
      textDecoration: "underline wavy #e5534b",
      textDecorationSkipInk: "none",
      textUnderlineOffset: "3px",
    },
    ".pg4-diag-warning": {
      textDecoration: "underline wavy #d29922",
      textDecorationSkipInk: "none",
      textUnderlineOffset: "3px",
    },
    ".pg4-diag-info": {
      textDecoration: "underline dotted #58a6ff",
      textUnderlineOffset: "3px",
    },
    ".pg4-tip": {
      font: "12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      padding: "8px 10px",
      maxWidth: "440px",
      maxHeight: "320px",
      overflow: "auto",
      whiteSpace: "normal",
    },
    ".pg4-tip .pg4-tip-title": { fontWeight: "700", marginBottom: "4px", fontSize: "12.5px" },
    ".pg4-tip .pg4-tip-sub": { opacity: "0.7", marginBottom: "6px" },
    ".pg4-tip table": { borderCollapse: "collapse", width: "100%" },
    ".pg4-tip td": { padding: "1px 8px 1px 0", verticalAlign: "top" },
    ".pg4-tip td.k": { opacity: "0.65", whiteSpace: "nowrap" },
    ".pg4-tip .pg4-sev-error": { color: "#e5534b", fontWeight: "700" },
    ".pg4-tip .pg4-sev-warning": { color: "#d29922", fontWeight: "700" },
    ".pg4-tip .pg4-sev-info": { color: "#58a6ff", fontWeight: "700" },
    ".pg4-tip code": { background: "rgba(127,127,127,.18)", padding: "0 3px", borderRadius: "3px" },
  };

  /**
   * 每个 EditorView 只允许 appendConfig 一次。
   *
   * StateEffect.appendConfig 是不可撤销的：脚本被重复运行（DevTools 里很常见）时，
   * 如果每次都重新 append，旧实例的 hoverTooltip / updateListener 会一直留在配置里，
   * 并且排在新实例前面 —— 表现为「悬停显示的是过期内容」。
   * 因此把扩展固定挂一次，全部通过 slot.session 读取「当前生效的会话」。
   */
  function ensureViewSlot(view, M) {
    if (view.__pg4Slot) return view.__pg4Slot;
    const { state: S, view: V } = M;

    const slot = {
      session: null,
      originalOverride: null,
      setDiagEffect: S.StateEffect.define(),
    };

    const diagField = S.StateField.define({
      create: () => V.Decoration.none,
      update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const e of tr.effects) {
          if (!e.is(slot.setDiagEffect)) continue;
          const marks = [];
          for (const d of e.value) {
            if (d.from >= d.to || d.to > tr.state.doc.length) continue;
            marks.push(
              V.Decoration.mark({ class: "pg4-diag-" + d.severity, attributes: { "data-pg4-diag": d.message } })
                .range(d.from, d.to)
            );
          }
          deco = V.Decoration.set(marks, true);
        }
        return deco;
      },
      provide: (f) => V.EditorView.decorations.from(f),
    });

    const hover = V.hoverTooltip(
      (v, pos, side) => (slot.session ? slot.session.buildHover(v, pos, side) : null),
      { hoverTime: Math.max(50, currentConfig.hoverDelayMs) }
    );

    const listener = V.EditorView.updateListener.of((u) => {
      const s = slot.session;
      if (!s || s.destroyed) return;
      s.onUpdate(u);
    });

    const handlers = V.EditorView.domEventHandlers({
      paste: (ev, v) => (slot.session ? slot.session.onPaste(ev, v) : false),
      keydown: (ev, v) => {
        const s = slot.session;
        if (s && ev.key === "Escape") s.suppressAutoUntil = Date.now() + 1200;
        if (isToggleCompletionKey(ev)) {
          ev.preventDefault();
          toggleCompletion(s && s.core, M, v);
        }
        return false;
      },
    });

    view.dispatch({
      effects: S.StateEffect.appendConfig.of([
        diagField, hover, listener, handlers, V.EditorView.baseTheme(BASE_THEME_SPEC),
      ]),
    });

    view.__pg4Slot = slot;
    return slot;
  }

  /** 每个编辑器一个 Session */
  class EditorSession {
    constructor(core, win, view, M) {
      this.core = core;
      this.win = win;
      this.view = view;
      this.M = M;
      this.id = "cm-" + Math.random().toString(36).slice(2, 8);
      this.diagnostics = [];
      this.suppressAutoUntil = 0;
      this.slot = null;
      this.completionFacet = null;
      this.destroyed = false;
      this.dbName = detectDatabaseName(win);
    }

    install() {
      const { autocomplete: A } = this.M;
      const view = this.view;
      const self = this;

      const slot = ensureViewSlot(view, this.M);
      const prev = slot.session;
      if (prev && prev !== this) prev.destroyed = true;
      slot.session = this;
      this.slot = slot;

      this.trigger = debounce(() => {
        if (self.destroyed || slot.session !== self) return;
        if (Date.now() < self.suppressAutoUntil) return;
        if (!currentConfig.completionEnabled) return;
        if (A.completionStatus(self.view.state) === "active") return;
        try { A.startCompletion(self.view); } catch { /* 忽略 */ }
      }, currentConfig.autoTriggerDelayMs);

      this.runDiag = debounce(() => self.refreshDiagnostics(), currentConfig.diagnosticsDebounceMs);

      this.hookCompletion();
      view.dom.setAttribute("data-pg4", this.id);
      this.refreshDiagnostics();
      return this;
    }

    onUpdate(u) {
      if (u.docChanged) this.runDiag();
      if (!u.docChanged) return;
      if (!u.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
      const pos = u.state.selection.main.head;
      const before = u.state.sliceDoc(Math.max(0, pos - 1), pos);
      if (before === "." || before === '"') { this.trigger(); return; }
      if (!/[A-Za-z0-9_$]/.test(before)) return;
      let n = 0;
      for (let i = pos - 1; i >= 0 && n < 8; i--) {
        if (!/[A-Za-z0-9_$]/.test(u.state.sliceDoc(i, i + 1))) break;
        n++;
      }
      if (n >= Math.max(1, currentConfig.autoTriggerMinChars)) this.trigger();
    }

    /**
     * 就地替换 pgAdmin 已注册的 override[0]。
     * 之所以不能 appendConfig(autocompletion({override})) —— 见文件头说明。
     */
    hookCompletion() {
      const { autocomplete: A } = this.M;
      const facet = findCompletionConfigFacet(A);
      if (!facet) { warn("未找到 completionConfig facet，补全接管失败"); return false; }
      this.completionFacet = facet;
      const cfg = this.view.state.facet(facet);
      if (!cfg || !Array.isArray(cfg.override) || !cfg.override.length) {
        dbg("该编辑器未配置补全 override，跳过补全接管");
        return false;
      }
      const slot = this.slot;
      if (cfg.override[0].__pg4) return true; // 已挂过：wrapper 读 slot.session，自动指向新会话
      slot.originalOverride = cfg.override[0];
      const wrapper = async function (ctx) {
        const s = slot.session;
        if (s && !s.destroyed) {
          try {
            const res = await s.completionSource(ctx);
            if (res && res.options && res.options.length) return res;
          } catch (e) {
            warn("completion source error:", e);
          }
        }
        if ((!s || currentConfig.fallbackToNative) && slot.originalOverride) {
          return slot.originalOverride.call(this, ctx);
        }
        return null;
      };
      wrapper.__pg4 = true;
      cfg.override[0] = wrapper;
      return true;
    }

    async completionSource(ctx) {
      if (!currentConfig.completionEnabled) return null;
      const graph = this.core.graph;
      if (!graph) return null;

      // 大文档不拼整篇字符串：用 CM6 的 sliceString 直接取光标附近的窗口，
      // 再用 base 把窗口内坐标还原成文档绝对坐标。
      // 旧写法是 ctx.state.doc.toString() —— 每 90 ms 就把整篇文档拼成一个新字符串。
      const doc = ctx.state.doc;
      const docLen = doc.length;
      let docText;
      let base = 0;
      if (docLen > ANALYZE_WINDOW_THRESHOLD) {
        base = Math.max(0, ctx.pos - ANALYZE_WINDOW_BACK);
        docText = doc.sliceString(base, Math.min(docLen, ctx.pos + ANALYZE_WINDOW_FWD));
      } else {
        docText = doc.toString();
      }
      const info = analyzeContext(docText, ctx.pos, graph, base);
      if (!info) return null;
      if (!ctx.explicit && !info.qualifier && info.typed.length < Math.max(1, currentConfig.autoTriggerMinChars)) {
        return null;
      }

      const usage = await this.core.getUsage();
      const cands = buildCandidates(info, graph, usage);
      if (!cands.length) return null;

      const self = this;
      const options = cands.map((c) => ({
        label: c.label,
        displayLabel: c.displayLabel,
        type: c.kind,
        detail: c.detail,
        boost: Math.max(-99, Math.min(99, c.boost)),
        info: c.docKind && c.target ? () => renderDocDom(self.win.document, c.docKind, c.target, graph) : undefined,
        apply: (v, completion, from, to) => {
          let realFrom = info.replaceFrom;
          let realTo = Math.max(to, ctx.pos);
          if (realFrom > from) realFrom = from;
          // 吞掉用户已经打出的右引号，避免出现 ""Name""
          if (info.hadOpenQuote && v.state.sliceDoc(realTo, realTo + 1) === '"') realTo += 1;
          const insert = c.insert;
          const cursor = realFrom + insert.length + (c.cursorOffset || 0);
          v.dispatch({
            changes: { from: realFrom, to: realTo, insert },
            selection: { anchor: cursor },
            userEvent: "input.complete",
            scrollIntoView: true,
          });
          if (c.usageKey) self.core.bumpUsage(c.usageKey);
        },
      }));

      return {
        from: info.from,
        options,
        validFor: /^[A-Za-z0-9_$\u0080-\uffff]*$/,
        // 带 displayLabel 的候选（关键字大小写规整）若不提供 getMatch 会丢失高亮；
        // displayLabel 与 label 等长，直接透传 CM6 算好的匹配区间即可
        getMatch: (_c, m) => m,
      };
    }

    buildHover(v, pos, side) {
      if (this.destroyed || !currentConfig.hoverEnabled) return null;
      const doc = this.win.document;

      // 1. 诊断消息优先
      for (const d of this.diagnostics) {
        if (pos >= d.from && pos <= d.to) {
          return {
            pos: d.from,
            end: d.to,
            above: true,
            create: () => {
              const dom = doc.createElement("div");
              dom.className = "pg4-tip";
              dom.innerHTML =
                `<div class="pg4-sev-${d.severity}">${d.severity === "error" ? "错误" : d.severity === "warning" ? "警告" : "提示"}</div>` +
                `<div>${escapeHtml(d.message)}</div>`;
              return { dom };
            },
          };
        }
      }

      const graph = this.core.graph;
      if (!graph) return null;

      // 2. 光标下的标识符
      const text = v.state.doc.toString();
      const tokens = tokenize(text, { keepComments: false });
      let hit = null, hitIdx = -1;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.from <= pos && pos <= t.to && t.type === T.IDENT) { hit = t; hitIdx = i; break; }
      }
      if (!hit) return null;

      const info = analyzeContext(text, hit.to, graph);
      const name = hit.value ?? hit.text;

      // alias.column
      const prevDot = tokens[hitIdx - 1];
      if (prevDot && prevDot.text === ".") {
        const q = tokens[hitIdx - 2];
        if (q && q.type === T.IDENT && info) {
          const rel = info.scope.get(searchKey(q.value ?? q.text));
          if (rel) {
            const col = rel.columnByKey[fold(name, hit.quoted)]
              || rel.columns.find((c) => searchKey(c.name) === searchKey(name));
            if (col) return tipFor(doc, hit, "column", { rel, col }, graph);
          }
        }
      }

      // 别名 / 表名
      if (info) {
        const rel = info.scope.get(searchKey(name));
        if (rel) return tipFor(doc, hit, "relation", rel, graph);
      }
      const res = resolveRelation(graph, name, hit.quoted, null);
      if (res.rel || res.caseMismatch) return tipFor(doc, hit, "relation", res.rel || res.caseMismatch, graph);

      // 作用域内的列
      if (info && info.scopeList.length) {
        for (const rel of info.scopeList) {
          const col = rel.columnByKey[fold(name, hit.quoted)]
            || rel.columns.find((c) => searchKey(c.name) === searchKey(name));
          if (col) return tipFor(doc, hit, "column", { rel, col }, graph);
        }
      }

      // 函数
      const ix = idx(graph);
      const fn = ix.functions.find((f) => searchKey(f.name) === searchKey(name));
      if (fn) return tipFor(doc, hit, "function", fn, graph);

      return null;
    }

    refreshDiagnostics() {
      if (this.destroyed || !this.slot) return;
      try {
        const graph = this.core.graph;
        const docLen = this.view.state.doc.length;
        // 诊断关闭 / 没有快照 / 文档超限：只负责清掉已有标记就返回。
        // 关键是不能在这里 doc.toString() —— 否则关掉开关也照样每次白拼一遍全文。
        const skip = !currentConfig.diagnosticsEnabled || !graph || docLen > MAX_DIAG_DOC_CHARS;
        if (skip) {
          if (this.diagnostics.length) {
            this.diagnostics = [];
            this.view.dispatch({ effects: this.slot.setDiagEffect.of([]) });
            this.core.onDiagnosticsChanged();
          }
          return;
        }
        const text = this.view.state.doc.toString();
        this.diagnostics = runDiagnostics(text, graph);
        this.view.dispatch({ effects: this.slot.setDiagEffect.of(this.diagnostics) });
        this.core.onDiagnosticsChanged();
      } catch (e) {
        dbg("diagnostics failed", e);
      }
    }

    onPaste(ev, v) {
      if (!currentConfig.smartPasteEnabled) return false;
      const clip = ev.clipboardData && ev.clipboardData.getData("text/plain");
      if (!clip) return false;
      const sel = v.state.selection.main;
      const t = transformPaste(clip, v.state.doc.toString(), sel.from);
      if (!t || t.insert === clip) return false;
      ev.preventDefault();
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: t.insert },
        selection: { anchor: sel.from + t.insert.length },
        userEvent: "input.paste",
      });
      this.core.toast(`智能粘贴：${t.reason} → 已转为 SQL 字面量`);
      return true;
    }

    destroy() {
      this.destroyed = true;
      this.trigger && this.trigger.cancel();
      this.runDiag && this.runDiag.cancel();
      // 已 append 的扩展无法撤销，只能把插槽置空让它们变成空操作；
      // 补全 override 则还原成 pgAdmin 原本的服务端源。
      try {
        const slot = this.slot;
        if (slot && slot.session === this) {
          slot.session = null;
          if (this.completionFacet && slot.originalOverride) {
            const cfg = this.view.state.facet(this.completionFacet);
            if (cfg && cfg.override && cfg.override[0] && cfg.override[0].__pg4) {
              cfg.override[0] = slot.originalOverride;
              slot.originalOverride = null;
            }
          }
          this.view.dispatch({ effects: slot.setDiagEffect.of([]) });
        }
      } catch { /* 编辑器可能已销毁 */ }
    }
  }

  /**
   * 查询历史：直接观察 pgAdmin 自己的上报请求，而不是猜快捷键。
   * pgAdmin 每次执行完都会 POST /sqleditor/query_history/<panelId>，
   * body 里带 query / total_time / row_affected / status —— 比 keydown 钩子完整得多
   * （工具栏按钮、Execute script、快捷键都覆盖，且拿得到真实耗时与结果）。
   */
  function installHistoryHook(win, core) {
    if (win.__pg4HistoryHook) return;
    const XHR = win.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    win.__pg4HistoryHook = true;

    const RE = /\/sqleditor\/query_history\//;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try { this.__pg4Url = String(url); } catch { /* ignore */ }
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      try {
        if (currentConfig.historyEnabled && this.__pg4Url && RE.test(this.__pg4Url) && typeof body === "string") {
          const p = JSON.parse(body);
          if (p && p.query && !p.is_pgadmin_query) {
            core.addHistory({
              sql: String(p.query).trim().slice(0, 20000),
              executedAt: Date.parse(p.start_time) || Date.now(),
              database: detectDatabaseName(win),
              durationText: p.total_time || null,
              rowsAffected: typeof p.row_affected === "number" ? p.row_affected : null,
              ok: p.status !== false,
              message: p.message ? String(p.message).slice(0, 500) : null,
            });
          }
        }
      } catch { /* 观察失败不影响原请求 */ }
      return origSend.call(this, body);
    };

    win.__pg4HistoryUnhook = () => {
      XHR.prototype.open = origOpen;
      XHR.prototype.send = origSend;
      win.__pg4HistoryHook = false;
    };
  }

  /**
   * 数据网格复制钩子：
   * 1. 拦截 pgAdmin Webpack 中的 CsvHelper (copyRowsToCsv)，当复制单个单元格且未带表头时，
   *    将去除 CSV 引号包装的原始纯文本写入剪贴板（避免如 "hello" 复制为带外层双引号）。
   * 2. 补丁 pgAdmin 结果网格在单单元格选中时键盘 Ctrl+C (Cmd+C) 缺失响应的问题（pgAdmin 自身的快捷键判定 bug）。
   */
  const GRID_HOOK_REV = 6;

  function installGridCopyHook(win) {
    if (win.__pg4GridCopyHook === GRID_HOOK_REV) return;
    if (win.__pg4GridCopyUnhook) {
      try { win.__pg4GridCopyUnhook(); } catch { /* ignore */ }
    }
    const req = grabWebpackRequire(win);
    if (!req || !req.m) return;

    // 寻找 CsvHelper 模块 (包含 copyRowsToCsv 与 stringQuoteCell)
    let csvHelperId = null;
    for (const id of Object.keys(req.m)) {
      const src = String(req.m[id]);
      if (src.includes("copyRowsToCsv") && src.includes("stringQuoteCell")) {
        csvHelperId = id;
        break;
      }
    }

    let unhookProto = null;
    if (csvHelperId) {
      try {
        const mod = req(csvHelperId);
        const CsvClass = mod && (mod.default || mod);
        if (CsvClass && CsvClass.prototype && typeof CsvClass.prototype.copyRowsToCsv === "function") {
          const proto = CsvClass.prototype;
          if (!proto.__pg4OrigCopy) {
            proto.__pg4OrigCopy = proto.copyRowsToCsv;
            proto.copyRowsToCsv = function (rows = [], cols = [], withHeaders = false) {
              if (currentConfig.gridUnquoteSingleCell && !withHeaders && rows.length === 1 && cols.length === 1) {
                const rawVal = rows[0][cols[0].key];
                let text = "";
                if (rawVal === null || rawVal === undefined) {
                  text = "";
                } else if (typeof rawVal === "object") {
                  text = JSON.stringify(rawVal);
                } else {
                  text = String(rawVal);
                }
                if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
                  win.navigator.clipboard.writeText(text);
                }
                try {
                  win.localStorage.setItem("copied-with-headers", withHeaders);
                  win.localStorage.setItem("copied-rows", JSON.stringify(rows));
                } catch { /* ignore */ }
                return;
              }
              return proto.__pg4OrigCopy.apply(this, arguments);
            };
            unhookProto = () => {
              if (proto.__pg4OrigCopy) {
                proto.copyRowsToCsv = proto.__pg4OrigCopy;
                delete proto.__pg4OrigCopy;
              }
            };
          }
        }
      } catch (e) {
        dbg("CsvHelper hook 失败", e);
      }
    }

    function findCopyButton(doc, titles) {
      return Array.from(doc.querySelectorAll("button")).find((b) => {
        const t = b.getAttribute("title") || b.getAttribute("aria-label") || "";
        return titles.some((x) => t === x || t.toLowerCase() === x.toLowerCase() || t.includes(x));
      });
    }

    // 补丁键盘快捷键：当焦点在结果网格单元格上按 Ctrl+C / Cmd+C 时，触发复制操作
    const onKeydown = (ev) => {
      const doc = win.document;
      if (!doc) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === "c" || ev.key === "C")) {
        const inBtn = doc.querySelector(".pg4-copy-in-btn");
        if (inBtn && !inBtn.disabled) {
          ev.preventDefault();
          ev.stopPropagation();
          copySelectionAsIn(doc);
          return;
        }
      }
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === "c" || ev.key === "C")) {
        const cell = doc.activeElement && doc.activeElement.closest(".rdg-cell[role='gridcell']");
        if (cell) {
          const copyBtn = findCopyButton(doc, ["复制", "Copy"]);
          if (copyBtn) {
            ev.preventDefault();
            ev.stopPropagation();
            copyBtn.click();
          }
        }
      }
    };

    /**
     * 从 ResultSet Fiber hooks 提取当前选区。
     * 优先级与 pgAdmin COPY_DATA 一致：整行 Set → 整列 Set → 矩形 range → 单单元格。
     */
    function extractGridSelection(doc) {
      let rowsState = null, colsState = null, cellRef = null;
      try {
        const grid = doc.querySelector(".rdg");
        if (!grid) return extractGridSelectionFromDom(doc, null, null);
        const fiberKey = Object.keys(grid).find((k) => k.startsWith("__reactFiber"));
        let cur = fiberKey ? grid[fiberKey] : null;

        while (cur) {
          let s = cur.memoizedState;
          let setCount = 0;
          let total = 0;
          while (s) {
            if (s.memoizedState instanceof Set) setCount++;
            s = s.next;
            total++;
          }
          if (setCount >= 2 && total > 15) break;
          cur = cur.return;
        }

        if (cur) {
          let selectedRowsSet = null, selectedColsSet = null, rangeRef = null, clientPK = "__temp_PK";
          let s = cur.memoizedState;
          let hookIdx = 0;
          while (s) {
            const ms = s.memoizedState;
            if (hookIdx === 4 && Array.isArray(ms)) rowsState = ms;
            if (hookIdx === 5 && Array.isArray(ms)) colsState = ms;
            if (hookIdx === 6 && ms && typeof ms === "object" && ms.current && ms.current.clientPK) {
              clientPK = ms.current.clientPK;
            }
            if (hookIdx === 8 && ms instanceof Set) selectedRowsSet = ms;
            if (hookIdx === 9 && ms instanceof Set) selectedColsSet = ms;
            if (hookIdx === 12 && ms && typeof ms === "object" && ms !== null && "current" in ms) cellRef = ms.current;
            if (hookIdx === 13 && ms && typeof ms === "object" && ms !== null && "current" in ms) rangeRef = ms.current;
            s = s.next;
            hookIdx++;
          }
          if (rowsState && colsState) {
            if (selectedRowsSet && selectedRowsSet.size > 0) {
              const rows = rowsState.filter((r) => selectedRowsSet.has(r[clientPK]));
              if (rows.length) return { kind: "rows", rows, cols: colsState };
            }
            if (selectedColsSet && selectedColsSet.size > 0) {
              const cols = colsState.filter((_, idx) => (
                selectedColsSet.has(idx) || selectedColsSet.has(idx + 1) || selectedColsSet.has(idx + 2)
              ));
              if (cols.length) return { kind: "cols", rows: rowsState, cols };
            }
            if (rangeRef && rangeRef.startColumnIdx != null) {
              const minCol = Math.min(rangeRef.startColumnIdx, rangeRef.endColumnIdx);
              const maxCol = Math.max(rangeRef.startColumnIdx, rangeRef.endColumnIdx);
              const minRow = Math.min(rangeRef.startRowIdx, rangeRef.endRowIdx);
              const maxRow = Math.max(rangeRef.startRowIdx, rangeRef.endRowIdx);
              const cols = colsState.filter((_, idx) => (idx + 1) >= minCol && (idx + 1) <= maxCol);
              const rows = rowsState.slice(minRow, maxRow + 1);
              if (rows.length && cols.length) return { kind: "range", rows, cols };
            }
          }
        }
      } catch (e) {
        dbg("extractGridSelection fiber", e);
      }
      const fromDom = extractGridSelectionFromDom(doc, rowsState, colsState);
      if (fromDom) return fromDom;
      if (Array.isArray(cellRef) && cellRef[0] && cellRef[1]) {
        return { kind: "cell", rows: [cellRef[0]], cols: [cellRef[1]] };
      }
      return null;
    }

    function cellDisplayValue(el) {
      const raw = (el.textContent || "").trim();
      if (raw === "[null]" || raw === "") return null;
      return raw;
    }

    function extractGridSelectionFromDom(doc, rowsState, colsState) {
      const grid = doc.querySelector(".rdg");
      if (!grid) return null;

      const selectedHeaders = Array.from(grid.querySelectorAll('.rdg-cell[role="columnheader"][aria-selected="true"]'));
      if (selectedHeaders.length) {
        const colIdxs = selectedHeaders.map((h) => Number(h.getAttribute("aria-colindex"))).filter(Boolean);
        const cols = colIdxs.map((idx) => {
          const fromState = colsState && colsState[idx - 2];
          if (fromState) return fromState;
          const header = selectedHeaders.find((h) => Number(h.getAttribute("aria-colindex")) === idx);
          const name = ((header && header.textContent) || "").trim().split("\n")[0] || ("col" + idx);
          return { key: name, name, type: "text", cell: "string", __colIndex: idx };
        });
        const dataRows = Array.from(grid.querySelectorAll('.rdg-row[role="row"]')).filter((r) => r.querySelector('.rdg-cell[role="gridcell"]'));
        const rows = dataRows.map((rowEl, i) => {
          const obj = rowsState && rowsState[i] ? { ...rowsState[i] } : {};
          cols.forEach((c, ci) => {
            const idx = colIdxs[ci];
            const cell = rowEl.querySelector(`.rdg-cell[role="gridcell"][aria-colindex="${idx}"]`);
            if (cell && (obj[c.key] === undefined)) obj[c.key] = cellDisplayValue(cell);
          });
          return obj;
        });
        if (rows.length && cols.length) return { kind: "cols", rows, cols };
      }

      const selectedRows = Array.from(grid.querySelectorAll('.rdg-row[role="row"][aria-selected="true"]'));
      if (selectedRows.length && colsState && colsState.length) {
        const rows = selectedRows.map((rowEl) => {
          const obj = {};
          colsState.forEach((c, i) => {
            const cell = rowEl.querySelector(`.rdg-cell[role="gridcell"][aria-colindex="${i + 2}"]`);
            obj[c.key] = cell ? cellDisplayValue(cell) : null;
          });
          return obj;
        });
        return { kind: "rows", rows, cols: colsState };
      }

      const selectedCells = Array.from(grid.querySelectorAll('.rdg-cell[role="gridcell"][aria-selected="true"]'));
      if (!selectedCells.length) return null;
      const colIdxs = [...new Set(selectedCells.map((c) => Number(c.getAttribute("aria-colindex"))))].filter(Boolean).sort((a, b) => a - b);
      const rowEls = [...new Set(selectedCells.map((c) => c.closest('.rdg-row[role="row"]')))].filter(Boolean);
      const cols = colIdxs.map((idx) => {
        const fromState = colsState && colsState[idx - 2];
        if (fromState) return fromState;
        const header = grid.querySelector(`.rdg-cell[role="columnheader"][aria-colindex="${idx}"]`);
        const name = ((header && header.textContent) || "").trim().split("\n")[0] || ("c" + idx);
        return { key: name, name, type: "text", cell: "string" };
      });
      const rows = rowEls.map((rowEl) => {
        const obj = {};
        cols.forEach((c, ci) => {
          const idx = colIdxs[ci];
          const cell = rowEl.querySelector(`.rdg-cell[role="gridcell"][aria-colindex="${idx}"]`);
          obj[c.key] = cell ? cellDisplayValue(cell) : null;
        });
        return obj;
      });
      if (rows.length && cols.length) return { kind: "range", rows, cols };
      return null;
    }

    function isNumericColumn(col) {
      const t = (col.type || col.cell || "").toLowerCase();
      return /int|float|double|num|real|decimal|serial/i.test(t);
    }

    function formatAsInClause(rows, cols) {
      if (!rows || !rows.length || !cols || !cols.length) return null;
      if (cols.length === 1) {
        const col = cols[0];
        const isNum = isNumericColumn(col);
        const items = rows.map((r) => {
          const val = r[col.key];
          if (val === null || val === undefined) return "NULL";
          if (isNum && !isNaN(Number(val)) && String(val).trim() !== "") return String(val).trim();
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        return `(${items.join(", ")})`;
      } else {
        const items = rows.map((r) => {
          const rowVals = cols.map((c) => {
            const val = r[c.key];
            if (val === null || val === undefined) return "NULL";
            if (isNumericColumn(c) && !isNaN(Number(val)) && String(val).trim() !== "") return String(val).trim();
            return `'${String(val).replace(/'/g, "''")}'`;
          });
          return `(${rowVals.join(", ")})`;
        });
        return `(${items.join(", ")})`;
      }
    }

    function writeClipboard(text) {
      let ok = false;
      try {
        const ta = win.document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:2147483647";
        win.document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = !!win.document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
      try {
        if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
          win.navigator.clipboard.writeText(text);
        }
      } catch { /* ignore */ }
      return ok;
    }

    function copySelectionAsIn(doc) {
      let selData = null;
      try { selData = extractGridSelection(doc); } catch (e) { dbg("extractGridSelection", e); }
      if (!selData || !selData.rows.length || !selData.cols.length) {
        const core = window[NS];
        if (core) core.toast("请先选中结果网格中的单元格 / 列 / 行");
        return false;
      }
      const text = formatAsInClause(selData.rows, selData.cols);
      if (!text) return false;
      if (writeClipboard(text)) {
        const core = window[NS];
        if (core) core.toast(`已复制 IN 条件（${selData.rows.length} 项）`);
        return true;
      }
      const core = window[NS];
      if (core) core.toast("复制失败：浏览器未允许写入剪贴板");
      return false;
    }

    let activeMenu = null;
    const hideMenu = () => {
      if (activeMenu) {
        activeMenu.remove();
        activeMenu = null;
      }
    };

    function showInMenu(doc, x, y) {
      const selData = extractGridSelection(doc);
      if (!selData || !selData.rows.length || !selData.cols.length) return;
      hideMenu();

      const menu = doc.createElement("div");
      menu.className = "pg4-grid-context-menu";
      menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:999999;background:var(--color-bg,#fff);color:var(--color-fg,#212121);border:1px solid rgba(127,127,127,.3);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.2);padding:4px 0;min-width:180px;font-size:12px;font-family:inherit;user-select:none;`;

      const itemIn = doc.createElement("div");
      itemIn.style.cssText = "padding:7px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:background .15s;";
      const colLabel = selData.cols.length === 1 ? escapeHtml(selData.cols[0].name || selData.cols[0].key) : `${selData.cols.length} 列`;
      itemIn.innerHTML = `<span>复制为 <b>IN (...)</b> 条件</span><span style="opacity:.6;font-size:11px;margin-left:8px">${selData.rows.length} 项 · ${colLabel}</span>`;
      itemIn.onmouseenter = () => { itemIn.style.background = "rgba(127,127,127,.15)"; };
      itemIn.onmouseleave = () => { itemIn.style.background = "transparent"; };
      itemIn.onclick = () => {
        copySelectionAsIn(doc);
        hideMenu();
      };
      menu.appendChild(itemIn);
      doc.body.appendChild(menu);
      activeMenu = menu;

      const r = menu.getBoundingClientRect();
      if (r.right > win.innerWidth) menu.style.left = `${Math.max(0, win.innerWidth - r.width - 8)}px`;
      if (r.bottom > win.innerHeight) menu.style.top = `${Math.max(0, win.innerHeight - r.height - 8)}px`;
    }

    // 右键 mousedown 会走 react-data-grid 的选中逻辑，把框选 / 整列收成单格。
    // 只 stopPropagation（不要 preventDefault，否则 Chrome 可能不再派发 contextmenu）。
    function eventEl(ev) {
      const t = ev && ev.target;
      if (!t) return null;
      return t.nodeType === 1 ? t : t.parentElement;
    }

    const onGridMouseDown = (ev) => {
      if (ev.button !== 2) return;
      const t = eventEl(ev);
      if (t && t.closest && t.closest(".rdg-cell")) ev.stopPropagation();
    };

    const onContextMenu = (ev) => {
      const doc = win.document;
      if (!doc) return;
      const t = eventEl(ev);
      const cell = t && t.closest && t.closest(".rdg-cell");
      if (!cell) {
        hideMenu();
        return;
      }
      const selData = extractGridSelection(doc);
      if (!selData || !selData.rows.length || !selData.cols.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      showInMenu(doc, ev.clientX, ev.clientY);
    };

    function ensureInToolbarButton(doc) {
      if (!doc.querySelector(".rdg")) return;
      if (doc.querySelector(".pg4-copy-in-btn")) return;
      const copyBtn = findCopyButton(doc, ["复制", "Copy"]);
      if (!copyBtn) return;
      const group = copyBtn.closest(".MuiButtonGroup-root");
      if (!group) return;
      const copyOptBtn = findCopyButton(doc, ["复制选项", "Copy options"]);
      const inBtn = doc.createElement("button");
      inBtn.type = "button";
      inBtn.className = (copyBtn.className || "") + " pg4-copy-in-btn";
      inBtn.title = "复制为 IN 条件 (Ctrl+Shift+C)";
      inBtn.setAttribute("aria-label", "复制为 IN 条件");
      inBtn.style.fontWeight = "700";
      inBtn.style.fontSize = "11px";
      inBtn.style.minWidth = "32px";
      inBtn.textContent = "IN";
      inBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        copySelectionAsIn(win.document);
      };
      if (copyOptBtn && copyOptBtn.parentNode === group) {
        group.insertBefore(inBtn, copyOptBtn.nextSibling);
      } else {
        group.appendChild(inBtn);
      }
    }

    let toolbarObserver = null;
    const syncToolbar = () => {
      try { ensureInToolbarButton(win.document); } catch { /* ignore */ }
    };

    const onDocClick = (ev) => {
      const el = ev.target && (ev.target.nodeType === 1 ? ev.target : ev.target.parentElement);
      const btn = el && el.closest && el.closest(".pg4-copy-in-btn");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      copySelectionAsIn(win.document);
    };

    // 点菜单外面收起菜单。必须具名：匿名函数拿不到引用，
    // removeEventListener 摘不掉，destroy → 重跑 每轮都会残留一个监听器。
    const onOutsidePointerDown = (ev) => {
      if (activeMenu && !activeMenu.contains(ev.target)) hideMenu();
    };

    try {
      win.addEventListener("keydown", onKeydown, true);
      win.addEventListener("mousedown", onGridMouseDown, true);
      win.addEventListener("contextmenu", onContextMenu, true);
      win.addEventListener("click", onDocClick, true);
      win.addEventListener("pointerdown", onOutsidePointerDown, true);
      syncToolbar();
      if (win.document && win.document.body) {
        toolbarObserver = new win.MutationObserver(debounce(syncToolbar, 250));
        toolbarObserver.observe(win.document.body, { childList: true, subtree: true });
      }
    } catch { /* ignore */ }

    win.__pg4GridCopyHook = GRID_HOOK_REV;
    win.__pg4GridCopyUnhook = () => {
      try {
        win.removeEventListener("keydown", onKeydown, true);
        win.removeEventListener("mousedown", onGridMouseDown, true);
        win.removeEventListener("contextmenu", onContextMenu, true);
        win.removeEventListener("click", onDocClick, true);
        win.removeEventListener("pointerdown", onOutsidePointerDown, true);
        hideMenu();
        if (toolbarObserver) toolbarObserver.disconnect();
        const leftover = win.document && win.document.querySelectorAll(".pg4-copy-in-btn");
        leftover && leftover.forEach((el) => el.remove());
      } catch { /* ignore */ }
      if (unhookProto) unhookProto();
      win.__pg4GridCopyHook = false;
    };
  }

  function detectDatabaseName(win) {
    try {
      const u = new URL(win.location.href);
      return u.searchParams.get("database_name") || null;
    } catch {
      return null;
    }
  }

  // ── 文档卡渲染 ───────────────────────────────────────────────────────────

  function tipFor(doc, tok, kind, target, graph) {
    return {
      pos: tok.from,
      end: tok.to,
      above: true,
      create: () => ({ dom: renderDocDom(doc, kind, target, graph) }),
    };
  }

  function renderDocDom(doc, kind, target, graph) {
    const el = doc.createElement("div");
    el.className = "pg4-tip";
    el.innerHTML = renderDocHtml(kind, target, graph);
    return el;
  }

  function renderDocHtml(kind, target, graph) {
    const ix = idx(graph);
    if (kind === "relation") {
      const rel = target;
      const pkCols = rel.pk.map((k) => colName(rel, k));
      const rows = [];
      rows.push(["类型", rel.kind === "table" ? "表" : rel.kind === "view" ? "视图" : rel.kind === "matview" ? "物化视图" : "外部表"]);
      rows.push(["schema", rel.schema]);
      rows.push(["列数", String(rel.columns.length)]);
      if (pkCols.length) rows.push(["主键", pkCols.map(escapeHtml).join(", ")]);
      if (rel.fks.length) rows.push(["外键", rel.fks.map((f) => `${f.columns.map((c) => colName(rel, c)).join(",")} → ${f.refTable}`).map(escapeHtml).join("<br>")]);
      if (rel.indexes.length) rows.push(["索引", String(rel.indexes.length) + " 个"]);
      const inbound = (ix.fkIn.get(ix.fullKey(rel)) || []).filter((e) => !e.implicit);
      if (inbound.length) rows.push(["被引用", String(inbound.length) + " 处"]);

      const preview = rel.columns.slice(0, 8)
        .map((c) => `<div><code>${escapeHtml(c.name)}</code> <span style="opacity:.6">${escapeHtml(c.type)}</span>${c.pk ? " <b>PK</b>" : ""}</div>`)
        .join("");
      const more = rel.columns.length > 8 ? `<div style="opacity:.6">… 另有 ${rel.columns.length - 8} 列</div>` : "";

      return `<div class="pg4-tip-title">${escapeHtml(quoteIdent(rel.name))}</div>` +
        (rel.comment ? `<div class="pg4-tip-sub">${escapeHtml(rel.comment)}</div>` : "") +
        `<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>` +
        `<div style="margin-top:6px;border-top:1px solid rgba(127,127,127,.25);padding-top:5px">${preview}${more}</div>`;
    }

    if (kind === "column") {
      const { rel, col } = target;
      const rows = [];
      rows.push(["类型", escapeHtml(col.type || "?")]);
      rows.push(["可空", col.notNull ? "NOT NULL" : "允许 NULL"]);
      if (col.default) rows.push(["默认值", `<code>${escapeHtml(col.default)}</code>`]);
      if (col.pk) rows.push(["约束", "PRIMARY KEY"]);
      const fk = rel.fks.find((f) => f.columns.includes(col.key));
      if (fk) rows.push(["外键", escapeHtml(`→ ${fk.refSchema}.${fk.refTable}(${fk.refColumns.join(",")})`)]);
      const inIdx = rel.indexes.filter((i2) => i2.columns.some((c) => searchKey(c) === searchKey(col.name)));
      if (inIdx.length) rows.push(["索引", inIdx.map((i2) => escapeHtml(i2.name || "(约束)") + (i2.unique ? " UNIQUE" : "")).join("<br>")]);
      const implicit = (ix.fkOut.get(ix.fullKey(rel)) || []).filter((e) => e.implicit && e.fromCols.includes(col.key));
      if (implicit.length) rows.push(["推断关联", implicit.map((e) => escapeHtml(e.to.name)).join(", ")]);

      return `<div class="pg4-tip-title">${escapeHtml(quoteIdent(rel.name))}.${escapeHtml(quoteIdent(col.name))}</div>` +
        (col.comment ? `<div class="pg4-tip-sub">${escapeHtml(col.comment)}</div>` : "") +
        `<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join("")}</table>`;
    }

    if (kind === "function") {
      const f = target;
      return `<div class="pg4-tip-title">${escapeHtml(f.schema)}.${escapeHtml(f.name)}</div>` +
        `<table>` +
        `<tr><td class="k">参数</td><td>${f.args.length ? f.args.map((a) => `<code>${escapeHtml(a)}</code>`).join("<br>") : "（无）"}</td></tr>` +
        (f.returns ? `<tr><td class="k">返回</td><td><code>${escapeHtml(f.returns)}</code></td></tr>` : "") +
        `</table>`;
    }

    if (kind === "schema") {
      const s = target;
      return `<div class="pg4-tip-title">${escapeHtml(s.name)}</div>` +
        `<table><tr><td class="k">对象</td><td>${Object.keys(s.relations).length}</td></tr>` +
        `<tr><td class="k">函数</td><td>${Object.keys(s.functions).length}</td></tr></table>`;
    }

    return "";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §12  控制面板 UI（只在顶层窗口渲染）
  // ═══════════════════════════════════════════════════════════════════════════

  const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.fab {
  position: fixed; right: 16px; bottom: 16px; width: 40px; height: 40px; z-index: 2147483000;
  border-radius: 50%; border: none; cursor: pointer; color: #fff; font-size: 15px; font-weight: 700;
  background: #2f6feb; box-shadow: 0 3px 12px rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center;
}
.fab:hover { background: #3b7ef5; }
.fab.idle { background: #6b7280; }
/* 补全已关闭（Ctrl+反引号快捷键）：空心虚线球，与 idle（无快照，实心灰）区分 */
.fab.off {
  background: transparent; border: 2px dashed #6b7280; color: #6b7280; box-shadow: none;
}
.fab.off:hover { background: rgba(107, 114, 128, .15); }
.fab .badge {
  position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px;
  border-radius: 9px; background: #e5534b; color: #fff; font-size: 10px; line-height: 17px; text-align: center;
}
.drawer {
  position: fixed; right: 0; top: 0; bottom: 0; width: 400px; z-index: 2147483001;
  background: #1c2128; color: #d7dde5; border-left: 1px solid #30363d;
  box-shadow: -4px 0 18px rgba(0,0,0,.4); display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform .18s ease-out; font-size: 12.5px;
}
.drawer.open { transform: none; }
.hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #30363d; }
.hd h2 { margin: 0; font-size: 13px; font-weight: 700; flex: 1; }
.hd .ver { opacity: .5; font-size: 11px; }
.hd button { background: none; border: none; color: #9aa4b1; font-size: 17px; cursor: pointer; padding: 0 4px; }
.tabs { display: flex; border-bottom: 1px solid #30363d; }
.tabs button {
  flex: 1; padding: 7px 4px; background: none; border: none; border-bottom: 2px solid transparent;
  color: #9aa4b1; cursor: pointer; font-size: 12px;
}
.tabs button.on { color: #fff; border-bottom-color: #2f6feb; }
.body { flex: 1; overflow: auto; padding: 12px; }
.sec { margin-bottom: 16px; }
.sec > h3 { margin: 0 0 7px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #7d8590; font-weight: 700; }
.row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.row label { flex: 1; cursor: pointer; }
.row input[type=checkbox] { width: 14px; height: 14px; accent-color: #2f6feb; cursor: pointer; }
.row input[type=number] { width: 64px; background: #0d1117; border: 1px solid #30363d; color: #d7dde5; border-radius: 4px; padding: 2px 5px; }
.btn {
  background: #2f6feb; border: none; color: #fff; padding: 6px 12px; border-radius: 5px;
  cursor: pointer; font-size: 12px;
}
.btn:hover { background: #3b7ef5; }
.btn.sec2 { background: #30363d; }
.btn.sec2:hover { background: #3c444d; }
.btn.danger { background: #6e2c28; }
.btn:disabled { opacity: .5; cursor: default; }
.snap { border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; margin-bottom: 7px; background: #22272e; }
.snap.active { border-color: #2f6feb; }
.snap .n { font-weight: 700; margin-bottom: 3px; word-break: break-all; }
.snap .m { opacity: .65; font-size: 11px; line-height: 1.6; }
.snap .acts { display: flex; gap: 6px; margin-top: 7px; }
.stat { display: flex; justify-content: space-between; padding: 2px 0; }
.stat b { font-weight: 600; }
.empty { opacity: .5; text-align: center; padding: 24px 0; }
pre.hist { background: #0d1117; border: 1px solid #30363d; border-radius: 5px; padding: 7px; margin: 0 0 6px;
  white-space: pre-wrap; word-break: break-all; max-height: 110px; overflow: auto; font-size: 11px; }
.hist-meta { opacity: .55; font-size: 10.5px; margin-bottom: 3px; }
.prog { height: 3px; background: #30363d; border-radius: 2px; overflow: hidden; margin-top: 6px; }
.prog i { display: block; height: 100%; background: #2f6feb; width: 0; transition: width .1s; }
.toast {
  position: fixed; right: 16px; bottom: 66px; z-index: 2147483002; background: #22272e; color: #d7dde5;
  border: 1px solid #30363d; border-left: 3px solid #2f6feb; padding: 8px 12px; border-radius: 5px;
  font-size: 12px; max-width: 320px; box-shadow: 0 3px 12px rgba(0,0,0,.35);
}
.diff-add { color: #57ab5a; } .diff-del { color: #e5534b; } .diff-chg { color: #d29922; }
.diff-item { padding: 2px 0; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
select { background: #0d1117; border: 1px solid #30363d; color: #d7dde5; border-radius: 4px; padding: 3px 5px; flex: 1; }
`;

  class Panel {
    constructor(core) {
      this.core = core;
      this.tab = "snapshots";
      this.open = false;
      this.build();
    }

    build() {
      const doc = document;
      const host = doc.createElement("div");
      host.id = "pg4-assist-host";
      host.style.cssText = "all:initial;position:fixed;z-index:2147483000";
      const root = host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = PANEL_CSS;
      root.appendChild(style);

      this.fab = doc.createElement("button");
      this.fab.className = "fab idle";
      this.fab.title = "PG4 Assist";
      this.fab.textContent = "PG";
      this.fab.onclick = () => this.toggle();
      root.appendChild(this.fab);

      this.drawer = doc.createElement("div");
      this.drawer.className = "drawer";
      this.drawer.innerHTML = `
        <div class="hd"><h2>PG4 Assist</h2><span class="ver">v${VERSION}</span><button data-act="close">×</button></div>
        <div class="tabs">
          <button data-tab="snapshots" class="on">快照</button>
          <button data-tab="settings">设置</button>
          <button data-tab="history">历史</button>
          <button data-tab="diff">对比</button>
        </div>
        <div class="body"></div>`;
      this.body = this.drawer.querySelector(".body");
      this.drawer.querySelector('[data-act="close"]').onclick = () => this.toggle(false);
      this.drawer.querySelectorAll("[data-tab]").forEach((b) => {
        b.onclick = () => {
          this.tab = b.dataset.tab;
          this.drawer.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
          this.render();
        };
      });
      root.appendChild(this.drawer);

      this.root = root;
      doc.documentElement.appendChild(host);
      this.host = host;

      // 点击面板/FAB 之外的任意位置收起面板（iframe 内的点击由 Core.attachWindow 另行监听）
      this._outsideDown = (ev) => {
        if (this.open && !ev.composedPath().includes(this.host)) this.toggle(false);
      };
      doc.addEventListener("pointerdown", this._outsideDown, true);
    }

    toggle(force) {
      this.open = force === undefined ? !this.open : force;
      this.drawer.classList.toggle("open", this.open);
      if (this.open) this.render();
    }

    toast(msg) {
      const el = document.createElement("div");
      el.className = "toast";
      el.textContent = msg;
      this.root.appendChild(el);
      setTimeout(() => el.remove(), 3200);
    }

    updateFab() {
      const core = this.core;
      const n = core.totalDiagnostics();
      this.fab.classList.toggle("idle", !core.graph);
      this.fab.classList.toggle("off", !currentConfig.completionEnabled);
      this.fab.title = (core.graph
        ? `PG4 Assist — ${core.snapshotMeta ? core.snapshotMeta.name : "?"} · ${core.sessions.size} 个编辑器`
        : "PG4 Assist — 未加载快照，点击导入 DDL")
        + (currentConfig.completionEnabled ? "" : " · 补全已关闭（Ctrl + ` 开启）");
      let badge = this.fab.querySelector(".badge");
      if (n > 0) {
        if (!badge) { badge = document.createElement("span"); badge.className = "badge"; this.fab.appendChild(badge); }
        badge.textContent = n > 99 ? "99+" : String(n);
      } else if (badge) badge.remove();
    }

    render() {
      if (!this.open) return;
      const r = {
        snapshots: () => this.renderSnapshots(),
        settings: () => this.renderSettings(),
        history: () => this.renderHistory(),
        diff: () => this.renderDiff(),
      }[this.tab];
      r && r();
    }

    async renderSnapshots() {
      const core = this.core;
      const list = await core.listSnapshots();
      const ix = core.graph ? idx(core.graph) : null;
      const st = ix ? ix.stats : null;

      this.body.innerHTML = `
        <div class="sec">
          <h3>运行状态</h3>
          <div class="stat"><span>已接管编辑器</span><b>${core.sessions.size}</b></div>
          <div class="stat"><span>活动快照</span><b>${core.snapshotMeta ? escapeHtml(core.snapshotMeta.name) : "—"}</b></div>
          ${st ? `<div class="stat"><span>对象</span><b>${st.relationCount} 表 / ${st.columnCount} 列 / ${st.functionCount} 函数</b></div>
                  <div class="stat"><span>关联</span><b>${st.fkCount} 外键 / ${st.indexCount} 索引</b></div>` : ""}
          <div class="stat"><span>当前诊断</span><b>${core.totalDiagnostics()}</b></div>
        </div>
        <div class="sec">
          <h3>导入 DDL 快照</h3>
          <div class="row">
            <button class="btn" data-act="import">选择 .sql 文件…</button>
            <button class="btn sec2" data-act="rescan">重新扫描编辑器</button>
          </div>
          <div class="prog" style="display:none"><i></i></div>
          <div class="imp-msg" style="opacity:.65;margin-top:6px"></div>
        </div>
        <div class="sec">
          <h3>已有快照（${list.length}）</h3>
          <div class="snap-list"></div>
        </div>`;

      const listEl = this.body.querySelector(".snap-list");
      if (!list.length) {
        listEl.innerHTML = `<div class="empty">还没有快照<br>导入 DDL 后即可获得离线补全</div>`;
      } else {
        list.sort((a, b) => b.importedAt - a.importedAt);
        for (const s of list) {
          const d = document.createElement("div");
          d.className = "snap" + (s.id === core.snapshotId ? " active" : "");
          d.innerHTML = `
            <div class="n">${escapeHtml(s.name)}</div>
            <div class="m">${escapeHtml(s.fileName || "")} · ${fmtBytes(s.bytes)} · ${new Date(s.importedAt).toLocaleString()}<br>
              ${s.stats.schemaCount} schema · ${s.stats.relationCount} 表/视图 · ${s.stats.columnCount} 列 · ${s.stats.functionCount} 函数
              ${s.warnings ? ` · <span style="color:#d29922">${s.warnings} 条警告</span>` : ""}</div>
            <div class="acts">
              <button class="btn" data-act="activate" ${s.id === core.snapshotId ? "disabled" : ""}>${s.id === core.snapshotId ? "已激活" : "激活"}</button>
              <button class="btn danger" data-act="delete">删除</button>
            </div>`;
          d.querySelector('[data-act="activate"]').onclick = async () => {
            await core.activateSnapshot(s.id);
            this.render();
          };
          d.querySelector('[data-act="delete"]').onclick = async () => {
            await core.deleteSnapshot(s.id);
            this.render();
          };
          listEl.appendChild(d);
        }
      }

      this.body.querySelector('[data-act="rescan"]').onclick = () => {
        const n = core.attachAll();
        this.toast(`扫描完成，共接管 ${core.sessions.size} 个编辑器（新增 ${n}）`);
        this.render();
      };

      this.body.querySelector('[data-act="import"]').onclick = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".sql,.txt,text/plain";
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const prog = this.body.querySelector(".prog");
          const bar = prog.querySelector("i");
          const msg = this.body.querySelector(".imp-msg");
          prog.style.display = "block";
          msg.textContent = "读取文件…";
          try {
            const text = await file.text();
            msg.textContent = "解析 DDL…";
            const res = await core.importDdlText(text, file.name.replace(/\.[^.]+$/, ""), file.name, (p) => {
              bar.style.width = Math.round(p * 100) + "%";
            });
            msg.innerHTML = `<span style="color:#57ab5a">导入成功</span>：${res.stats.relationCount} 表/视图、${res.stats.columnCount} 列、${res.stats.functionCount} 函数`
              + (res.warnings.length ? `，<span style="color:#d29922">${res.warnings.length} 条警告</span>` : "");
            setTimeout(() => this.render(), 900);
          } catch (e) {
            msg.innerHTML = `<span style="color:#e5534b">导入失败：${escapeHtml((e && e.message) || String(e))}</span>`;
          }
        };
        input.click();
      };
    }

    renderSettings() {
      const c = currentConfig;
      const chk = (key, label, hint) =>
        `<div class="row"><input type="checkbox" id="c_${key}" ${c[key] ? "checked" : ""}><label for="c_${key}">${label}${hint ? `<br><span style="opacity:.5;font-size:11px">${hint}</span>` : ""}</label></div>`;
      const num = (key, label, min, max) =>
        `<div class="row"><label for="c_${key}">${label}</label><input type="number" id="c_${key}" value="${c[key]}" min="${min}" max="${max}"></div>`;

      this.body.innerHTML = `
        <div class="sec"><h3>补全</h3>
          ${chk("completionEnabled", "启用离线补全")}
          ${num("autoTriggerMinChars", "自动触发字符数", 1, 5)}
          ${num("autoTriggerDelayMs", "触发延迟 (ms)", 0, 2000)}
          ${num("maxCandidates", "最大候选数", 10, 500)}
          ${chk("fallbackToNative", "离线候选为空时回落到 pgAdmin 服务端补全", "关闭后完全离线")}
        </div>
        <div class="sec"><h3>悬停</h3>
          ${chk("hoverEnabled", "启用对象悬停文档")}
          ${num("hoverDelayMs", "悬停延迟 (ms)", 0, 3000)}
        </div>
        <div class="sec"><h3>诊断</h3>
          ${chk("diagnosticsEnabled", "启用实时诊断", "默认关闭：每次按键都会对全文重新分词，长脚本下开销明显")}
          ${chk("diagUnknownObject", "未知表 / 未知列")}
          ${chk("diagQuoteRequired", "标识符大小写与引号检查", "本库标识符均为带引号的 PascalCase")}
          ${chk("diagMissingWhere", "UPDATE / DELETE 缺少 WHERE")}
          ${chk("diagSelectStar", "SELECT * 提醒")}
          ${num("diagnosticsDebounceMs", "诊断防抖 (ms)", 100, 3000)}
        </div>
        <div class="sec"><h3>其他</h3>
          ${chk("smartPasteEnabled", "智能粘贴（自动加单引号 / 转 IN 列表）")}
          ${chk("gridUnquoteSingleCell", "结果单元格复制自动去外层双引号", "单选单元格复制时保留纯净数据，避免意外带上 CSV 双引号")}
          ${chk("historyEnabled", "记录查询历史（观察 pgAdmin 执行上报）")}
          ${chk("debug", "调试日志")}
        </div>
        <div class="sec">
          <button class="btn sec2" data-act="reset">恢复默认设置</button>
        </div>`;

      this.body.querySelectorAll("input").forEach((el) => {
        const key = el.id.slice(2);
        el.onchange = () => {
          const v = el.type === "checkbox" ? el.checked : Number(el.value);
          this.core.setConfig({ [key]: v });
        };
      });
      this.body.querySelector('[data-act="reset"]').onclick = () => {
        // 快照绑定不属于“设置”，重置时不该丢掉
        this.core.setConfig({ ...DEFAULT_CONFIG, activeSnapshotId: currentConfig.activeSnapshotId });
        this.render();
      };
    }

    async renderHistory() {
      const rows = await this.core.listHistory(80);
      if (!rows.length) {
        this.body.innerHTML = `<div class="empty">暂无历史<br>在查询窗口执行任意语句后会自动记录</div>`;
        return;
      }
      this.body.innerHTML =
        `<div class="sec"><div class="row"><span style="flex:1">共 ${rows.length} 条</span>
          <button class="btn danger" data-act="clear">清空</button></div></div>` +
        rows.map((r) => {
          const bits = [new Date(r.executedAt).toLocaleString()];
          if (r.database) bits.push(escapeHtml(r.database));
          if (r.durationText) bits.push(escapeHtml(r.durationText));
          if (r.rowsAffected != null) bits.push(r.rowsAffected + " 行");
          if (r.ok === false) bits.push('<span style="color:#e5534b">失败</span>');
          return `<div class="hist-meta">${bits.join(" · ")}</div><pre class="hist">${escapeHtml(r.sql)}</pre>`;
        }).join("");
      const btn = this.body.querySelector('[data-act="clear"]');
      if (btn) btn.onclick = async () => { await this.core.clearHistory(); this.render(); };
    }

    async renderDiff() {
      const list = (await this.core.listSnapshots()).sort((a, b) => b.importedAt - a.importedAt);
      if (list.length < 2) {
        this.body.innerHTML = `<div class="empty">至少需要两个快照才能对比</div>`;
        return;
      }
      const opts = (sel) => list.map((s) => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("");
      this.body.innerHTML = `
        <div class="sec"><h3>选择快照</h3>
          <div class="row"><span style="width:34px">旧</span><select id="d_a">${opts(list[1].id)}</select></div>
          <div class="row"><span style="width:34px">新</span><select id="d_b">${opts(list[0].id)}</select></div>
          <div class="row"><button class="btn" data-act="run">对比</button></div>
        </div>
        <div class="sec diff-out"></div>`;
      this.body.querySelector('[data-act="run"]').onclick = async () => {
        const a = this.body.querySelector("#d_a").value;
        const b = this.body.querySelector("#d_b").value;
        const out = this.body.querySelector(".diff-out");
        out.innerHTML = "对比中…";
        const d = await this.core.diffSnapshots(a, b);
        out.innerHTML =
          `<h3>结果</h3>` +
          `<div class="stat"><span>新增表</span><b class="diff-add">${d.addedRelations.length}</b></div>` +
          `<div class="stat"><span>删除表</span><b class="diff-del">${d.removedRelations.length}</b></div>` +
          `<div class="stat"><span>变更表</span><b class="diff-chg">${d.changedRelations.length}</b></div>` +
          d.addedRelations.map((x) => `<div class="diff-item diff-add">+ ${escapeHtml(x)}</div>`).join("") +
          d.removedRelations.map((x) => `<div class="diff-item diff-del">− ${escapeHtml(x)}</div>`).join("") +
          d.changedRelations.map((c) =>
            `<div class="diff-item diff-chg">~ ${escapeHtml(c.name)}</div>` +
            c.addedColumns.map((x) => `<div class="diff-item diff-add">　　+ ${escapeHtml(x)}</div>`).join("") +
            c.removedColumns.map((x) => `<div class="diff-item diff-del">　　− ${escapeHtml(x)}</div>`).join("") +
            c.changedColumns.map((x) => `<div class="diff-item diff-chg">　　~ ${escapeHtml(x)}</div>`).join("")
          ).join("");
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §13  Core：数据 + 会话注册 + frame 注入
  // ═══════════════════════════════════════════════════════════════════════════

  class Core {
    constructor() {
      this.sessions = new Map();     // sessionId -> EditorSession
      this.graph = null;
      this.snapshotId = null;
      this.snapshotMeta = null;
      this.usageCache = null;
      this.panel = null;
      this.disposed = false;
      this.moduleCache = new WeakMap(); // window -> M
      this.observers = [];
      this.channel = null;
    }

    // ── 配置 ──────────────────────────────────────────────────────────────
    setConfig(patch) {
      saveConfig(patch);
      try { this.channel && this.channel.postMessage({ type: "config", config: currentConfig }); } catch { /* ignore */ }
      for (const s of this.sessions.values()) s.refreshDiagnostics();
      this.onDiagnosticsChanged();
    }

    // ── 快照 ──────────────────────────────────────────────────────────────
    async listSnapshots() {
      return (await idbAll(ST_SNAPSHOTS)) || [];
    }

    async importDdlText(text, name, fileName, onProgress) {
      const t0 = performance.now();
      const { graph, warnings } = await parseDdl(text, onProgress);
      const ix = buildIndex(graph);
      const id = "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      const meta = {
        id,
        name: name || fileName || "snapshot",
        fileName: fileName || null,
        importedAt: Date.now(),
        bytes: text.length,
        stats: ix.stats,
        warnings: warnings.length,
        parseMs: Math.round(performance.now() - t0),
      };
      await idbPut(ST_SNAPSHOTS, meta);
      await idbPut(ST_GRAPHS, { snapshotId: id, graph: serializeGraph(graph) });
      log(`快照导入完成 ${meta.parseMs}ms`, meta.stats);
      await this.activateSnapshot(id);
      return { meta, warnings, stats: ix.stats };
    }

    async activateSnapshot(id) {
      const meta = await idbGet(ST_SNAPSHOTS, id);
      if (!meta) return false;
      const row = await idbGet(ST_GRAPHS, id);
      if (!row) return false;
      this.graph = row.graph;
      buildIndex(this.graph);
      this.snapshotId = id;
      this.snapshotMeta = meta;
      this.usageCache = null;
      saveConfig({ activeSnapshotId: id });
      for (const s of this.sessions.values()) s.refreshDiagnostics();
      this.onDiagnosticsChanged();
      log("已激活快照", meta.name, idx(this.graph).stats);
      return true;
    }

    async deleteSnapshot(id) {
      await idbDel(ST_SNAPSHOTS, id);
      await idbDel(ST_GRAPHS, id);
      if (this.snapshotId === id) {
        this.graph = null;
        this.snapshotId = null;
        this.snapshotMeta = null;
        saveConfig({ activeSnapshotId: null });
        for (const s of this.sessions.values()) s.refreshDiagnostics();
      }
      this.onDiagnosticsChanged();
    }

    async restoreActiveSnapshot() {
      const id = currentConfig.activeSnapshotId;
      if (id) {
        const ok = await this.activateSnapshot(id).catch(() => false);
        if (ok) return;
      }
      const list = await this.listSnapshots();
      if (list.length) {
        list.sort((a, b) => b.importedAt - a.importedAt);
        await this.activateSnapshot(list[0].id).catch(() => {});
      }
    }

    async diffSnapshots(idA, idB) {
      const [ra, rb] = await Promise.all([idbGet(ST_GRAPHS, idA), idbGet(ST_GRAPHS, idB)]);
      return diffGraphs(ra && ra.graph, rb && rb.graph);
    }

    // ── 使用频次 ──────────────────────────────────────────────────────────
    async getUsage() {
      if (!this.snapshotId) return new Map();
      if (this.usageCache) return this.usageCache;
      const rows = await idbRun([ST_USAGE], "readonly", (s) => s.index("bySnapshot").getAll(IDBKeyRange.only(this.snapshotId)));
      const m = new Map();
      for (const r of rows || []) m.set(r.symbol, r.count);
      this.usageCache = m;
      return m;
    }

    bumpUsage(symbol) {
      if (!this.snapshotId || !symbol) return;
      const m = this.usageCache || (this.usageCache = new Map());
      m.set(symbol, (m.get(symbol) || 0) + 1);
      const snapshotId = this.snapshotId;
      idbRun([ST_USAGE], "readwrite", (s) => {
        const req = s.get([snapshotId, symbol]);
        req.onsuccess = () => {
          const prev = req.result;
          s.put({ snapshotId, symbol, count: (prev ? prev.count : 0) + 1, lastUsed: Date.now() });
        };
      }).catch(() => {});
    }

    // ── 历史 ──────────────────────────────────────────────────────────────
    addHistory(entry) {
      idbPut(ST_HISTORY, entry).catch(() => {});
      if (Math.random() < 0.05) this.pruneHistory();
    }

    async listHistory(limit = 50) {
      const rows = (await idbAll(ST_HISTORY)) || [];
      rows.sort((a, b) => b.executedAt - a.executedAt);
      return rows.slice(0, limit);
    }

    async clearHistory() {
      await idbRun([ST_HISTORY], "readwrite", (s) => s.clear());
    }

    async pruneHistory() {
      const cutoff = Date.now() - currentConfig.historyRetentionDays * 86400000;
      await idbRun([ST_HISTORY], "readwrite", (s) => {
        const req = s.index("byTime").openCursor(IDBKeyRange.upperBound(cutoff));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          c.delete();
          c.continue();
        };
      }).catch(() => {});
      const n = await idbRun([ST_HISTORY], "readonly", (s) => s.count()).catch(() => 0);
      if (n > MAX_HISTORY_ROWS) {
        let toDelete = n - MAX_HISTORY_ROWS;
        await idbRun([ST_HISTORY], "readwrite", (s) => {
          const req = s.index("byTime").openCursor();
          req.onsuccess = () => {
            const c = req.result;
            if (!c || toDelete <= 0) return;
            c.delete();
            toDelete--;
            c.continue();
          };
        }).catch(() => {});
      }
    }

    // ── UI 反馈 ───────────────────────────────────────────────────────────
    toast(msg) { this.panel && this.panel.toast(msg); }
    totalDiagnostics() {
      let n = 0;
      for (const s of this.sessions.values()) n += s.diagnostics.filter((d) => d.severity !== "info").length;
      return n;
    }
    onDiagnosticsChanged() {
      if (this.panel) {
        this.panel.updateFab();
        if (this.panel.open && this.panel.tab === "snapshots") {
          clearTimeout(this._rerender);
          this._rerender = setTimeout(() => this.panel.render(), 200);
        }
      }
    }

    // ── 编辑器接管 ────────────────────────────────────────────────────────
    getModules(win, view) {
      if (this.moduleCache.has(win)) return this.moduleCache.get(win);
      const req = grabWebpackRequire(win);
      if (!req) { this.moduleCache.set(win, null); return null; }
      const M = locateCm6Modules(req, view);
      this.moduleCache.set(win, M);
      if (!M) warn("未能在", win.location.pathname, "定位 CodeMirror 模块");
      return M;
    }

    attachWindow(win) {
      if (this.disposed) return 0;
      let added = 0;
      let contents;
      try { contents = win.document.querySelectorAll(".cm-content"); } catch { return 0; }
      if (contents.length) {
        installHistoryHook(win, this);
        installGridCopyHook(win);
      }
      // iframe 内点击（不会冒泡到顶层 document）→ 收起顶层控制面板。
      // 仅子 frame：顶层的面板/FAB 点击由 Panel._outsideDown 处理（需排除 host 自身）。
      // 与 watchFrameLoad 同款模式：监听器不捕获 core，每次从顶层取当前实例，
      // 脚本重跑后遗留监听器自动指向新实例（因此 destroy 无需清理）
      if (win !== window && !win.__pg4PanelOutside) {
        win.__pg4PanelOutside = true;
        win.document.addEventListener("pointerdown", () => {
          const core = window[NS];
          if (core && !core.disposed && core.panel && core.panel.open) core.panel.toggle(false);
        }, true);
      }
      for (const el of contents) {
        if (el.__pg4Session && this.sessions.has(el.__pg4Session)) continue;
        const cmView = el.cmView;
        const view = cmView && cmView.view;
        if (!view || typeof view.dispatch !== "function") continue;
        // pgAdmin 的「查询历史」面板也是一个 CM6 实例，但是只读的，不需要增强
        if (view.state.readOnly) continue;
        const M = this.getModules(win, view);
        if (!M) continue;
        try {
          const sess = new EditorSession(this, win, view, M).install();
          this.sessions.set(sess.id, sess);
          el.__pg4Session = sess.id;
          added++;
          dbg("adopted editor", sess.id, win.location.pathname, sess.dbName);
        } catch (e) {
          warn("接管编辑器失败：", e);
        }
      }
      return added;
    }

    /** 扫描顶层 + 所有同源 iframe */
    attachAll() {
      if (this.disposed) return 0;
      let added = this.attachWindow(window);
      // 注意：外层 DIV 与 IFRAME 共用同一个 id，必须走 querySelectorAll('iframe')
      for (const frameEl of document.querySelectorAll("iframe")) {
        const w = sameOriginWindow(frameEl);
        if (!w || !w.document) continue;
        added += this.attachWindow(w);
        this.observeDom(w, frameEl);
        watchFrameLoad(frameEl);
      }
      this.gcSessions();
      this.pruneObservers();
      this.onDiagnosticsChanged();
      return added;
    }

    observeDom(win, frameEl) {
      if (this.disposed || win.__pg4Observer) return;
      try {
        if (!win.document || !win.document.body) return;
        const mo = new win.MutationObserver(
          debounce(() => {
            if (this.disposed) return;
            this.attachWindow(win);
            this.onDiagnosticsChanged();
          }, 250)
        );
        mo.observe(win.document.body, { childList: true, subtree: true });
        win.__pg4Observer = mo;
        this.observers.push({ mo, win, frameEl: frameEl || null });
      } catch { /* frame 已卸载 */ }
    }

    /**
     * 回收已经失效的 iframe 观察器。这些条目**强引用 win**（等于整个 frame 的 JS 堆），
     * 不清的话每开关一次 Query Tool 标签页就多留一份，一直要到 destroy 才释放。
     * 失效有两种情形：
     *   1. iframe 元素被摘出文档（isConnected 为 false）；
     *   2. iframe 发生了导航 —— 元素还在，但 contentWindow 已经换成新窗口，
     *      旧窗口的 observer 必须一并回收，否则新窗口会再挂一个、旧的不走。
     * 顶层窗口（frameEl 为 null）不参与回收。
     */
    pruneObservers() {
      for (let i = this.observers.length - 1; i >= 0; i--) {
        const o = this.observers[i];
        let gone = false;
        if (o.frameEl) {
          try {
            gone = !o.frameEl.isConnected || sameOriginWindow(o.frameEl) !== o.win;
          } catch { gone = true; }
        }
        if (!gone) continue;
        try { o.mo.disconnect(); } catch { /* ignore */ }
        try { delete o.win.__pg4Observer; } catch { /* ignore */ }
        this.observers.splice(i, 1);
      }
    }

    gcSessions() {
      for (const [id, s] of this.sessions) {
        let alive = false;
        try { alive = !!s.view.dom.isConnected; } catch { alive = false; }
        if (!alive) {
          s.destroy();
          this.sessions.delete(id);
        }
      }
    }

    async start() {
      loadConfig();
      this.panel = new Panel(this);
      this.channel = (() => {
        try {
          const c = new BroadcastChannel("pg4-assist");
          c.onmessage = (ev) => {
            if (ev.data && ev.data.type === "config") currentConfig = { ...DEFAULT_CONFIG, ...ev.data.config };
          };
          return c;
        } catch { return null; }
      })();

      this.attachAll();
      // pgAdmin 的标签页是懒加载的，新开 Query Tool 会晚一些出现
      this.observeDom(window);
      this._poll = setInterval(() => {
        this.attachAll();
      }, 4000);

      // 焦点不在编辑器（如面板/页面）时也能用 Ctrl + ` 切换补全；
      // 编辑器内的按键由 domEventHandlers 覆盖（iframe 内按键不冒泡到顶层）
      this._topKeydown = (ev) => {
        if (isToggleCompletionKey(ev)) {
          ev.preventDefault();
          toggleCompletion(this, null, null);
        }
      };
      document.addEventListener("keydown", this._topKeydown);

      await this.restoreActiveSnapshot().catch((e) => warn("恢复快照失败", e));
      this.panel.updateFab();
      log(`PG4 Assist v${VERSION} 已启动 · 接管 ${this.sessions.size} 个编辑器 · 快照 ${this.snapshotMeta ? this.snapshotMeta.name : "（无）"}`);
      if (!this.sessions.size) {
        warn("未接管到任何编辑器。请确认已打开 Query Tool；若仍无效，在面板中点「重新扫描编辑器」。");
      }
    }

    destroy() {
      this.disposed = true;
      clearInterval(this._poll);
      document.removeEventListener("keydown", this._topKeydown);
      for (const { mo, win } of this.observers) {
        try { mo.disconnect(); } catch { /* ignore */ }
        try { delete win.__pg4Observer; } catch { /* ignore */ }
      }
      this.observers = [];
      const wins = new Set([window, ...[...this.sessions.values()].map((s) => s.win)]);
      for (const s of this.sessions.values()) s.destroy();
      this.sessions.clear();
      for (const w of wins) {
        try { w.__pg4HistoryUnhook && w.__pg4HistoryUnhook(); } catch { /* ignore */ }
        try { w.__pg4GridCopyUnhook && w.__pg4GridCopyUnhook(); } catch { /* ignore */ }
      }
      if (this.panel) {
        try { document.removeEventListener("pointerdown", this.panel._outsideDown, true); } catch { /* ignore */ }
      }
      try { this.panel.host.remove(); } catch { /* ignore */ }
      try { this.channel && this.channel.close(); } catch { /* ignore */ }
      // window.__pg4 是另一个对象（见 startHere），只删 window[NS] 不够：
      // window.__pg4.core 会一直强引用本实例，连带整份 graph 都回收不掉。
      try { delete window.__pg4; } catch { /* ignore */ }
      this.graph = null;
      this.usageCache = null;
      this.snapshotMeta = null;
      this.panel = null;
      delete window[NS];
      log("PG4 Assist 已卸载");
    }
  }

  // ── 快照序列化 / 对比 ────────────────────────────────────────────────────

  /**
   * iframe 重新导航后重新接管。
   * 监听器只登记一次且不捕获 core —— 每次都从 window[NS] 取当前实例，
   * 这样脚本重跑（旧 core 被 destroy）后遗留的监听器也会自动指向新实例。
   */
  function watchFrameLoad(frameEl) {
    if (frameEl.__pg4Watched) return;
    frameEl.__pg4Watched = true;
    frameEl.addEventListener("load", () => {
      setTimeout(() => {
        const core = window[NS];
        if (!core || core.disposed) return;
        const w = sameOriginWindow(frameEl);
        if (!w) return;
        core.observeDom(w, frameEl);
        core.attachWindow(w);
        core.onDiagnosticsChanged();
      }, 300);
    });
  }

  function serializeGraph(graph) {
    // columnByKey / __index 是运行期结构，不入库
    const out = { version: graph.version, schemas: {} };
    for (const sk of Object.keys(graph.schemas)) {
      const s = graph.schemas[sk];
      const relations = {};
      for (const rk of Object.keys(s.relations)) {
        const r = s.relations[rk];
        relations[rk] = {
          kind: r.kind, schema: r.schema, schemaKey: r.schemaKey, name: r.name, quoted: r.quoted,
          key: r.key, columns: r.columns, pk: r.pk, fks: r.fks, indexes: r.indexes, comment: r.comment,
        };
      }
      out.schemas[sk] = {
        key: s.key, name: s.name, quoted: s.quoted,
        relations, functions: s.functions, sequences: s.sequences,
      };
    }
    return out;
  }

  function diffGraphs(a, b) {
    const res = { addedRelations: [], removedRelations: [], changedRelations: [] };
    if (!a || !b) return res;
    const flat = (g) => {
      const m = new Map();
      for (const sk of Object.keys(g.schemas)) {
        for (const rk of Object.keys(g.schemas[sk].relations)) {
          const r = g.schemas[sk].relations[rk];
          m.set(sk + "." + rk, r);
        }
      }
      return m;
    };
    const ma = flat(a), mb = flat(b);
    for (const [k, r] of mb) if (!ma.has(k)) res.addedRelations.push(r.schema + "." + r.name);
    for (const [k, r] of ma) if (!mb.has(k)) res.removedRelations.push(r.schema + "." + r.name);
    for (const [k, ra] of ma) {
      const rb = mb.get(k);
      if (!rb) continue;
      const ca = new Map(ra.columns.map((c) => [c.key, c]));
      const cb = new Map(rb.columns.map((c) => [c.key, c]));
      const added = [], removed = [], changed = [];
      for (const [ck, c] of cb) if (!ca.has(ck)) added.push(`${c.name} ${c.type}`);
      for (const [ck, c] of ca) if (!cb.has(ck)) removed.push(`${c.name} ${c.type}`);
      for (const [ck, c] of ca) {
        const c2 = cb.get(ck);
        if (!c2) continue;
        if (c.type !== c2.type || c.notNull !== c2.notNull || c.pk !== c2.pk) {
          changed.push(`${c.name}: ${c.type}${c.notNull ? " NOT NULL" : ""} → ${c2.type}${c2.notNull ? " NOT NULL" : ""}`);
        }
      }
      if (added.length || removed.length || changed.length) {
        res.changedRelations.push({
          name: ra.schema + "." + ra.name,
          addedColumns: added, removedColumns: removed, changedColumns: changed,
        });
      }
    }
    return res;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // §14  引导
  // ═══════════════════════════════════════════════════════════════════════════

  function bootstrap() {
    // 用户脚本会在每个 frame 都执行一次：如果顶层（同源）已经在管，子 frame 直接退出
    if (window !== window.top) {
      try {
        if (window.top.location.origin === window.location.origin) {
          if (window.top[NS]) return;
          // 顶层还没起来 —— 等它起；轮询几次后再决定是否自己单干
          let tries = 0;
          const t = setInterval(() => {
            if (window.top[NS] || ++tries > 20) {
              clearInterval(t);
              if (!window.top[NS]) startHere();
            }
          }, 500);
          return;
        }
      } catch { /* 跨源：只能自己单干 */ }
    }
    startHere();
  }

  function startHere() {
    if (window[NS]) {
      log("已在运行，跳过（如需重载请先执行 window." + NS + ".destroy()）");
      window[NS].panel && window[NS].panel.toggle(true);
      return;
    }
    const core = new Core();
    window[NS] = core;
    // 调试/自动化入口
    window.__pg4 = {
      core,
      version: VERSION,
      get config() { return currentConfig; },
      setConfig: (p) => core.setConfig(p),
      importDdlText: (t, n, f, cb) => core.importDdlText(t, n, f, cb),
      attachAll: () => core.attachAll(),
      analyzeContext,
      buildCandidates,
      runDiagnostics,
      transformPaste,
      tokenize,
      parseDdl,
      buildIndex,
      destroy: () => core.destroy(),
    };
    core.start().catch((e) => console.error("[pg4] 启动失败", e));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
