// src/runtime/worker-rpc.ts
var WorkerRpcServer = class {
  handlers = /* @__PURE__ */ new Map();
  constructor() {
    self.addEventListener("message", this.onMessage);
  }
  handle(type, fn) {
    this.handlers.set(type, fn);
  }
  onMessage = async (ev) => {
    const req = ev.data;
    if (!req || typeof req.id !== "string" || typeof req.type !== "string") return;
    const fn = this.handlers.get(req.type);
    if (!fn) {
      this.reply(req.id, false, { code: "no-handler", message: `no handler for ${req.type}` });
      return;
    }
    try {
      const result = await fn(req);
      this.reply(req.id, true, result);
    } catch (e) {
      this.reply(req.id, false, { code: "handler-error", message: e?.message ?? String(e) });
    }
  };
  reply(id, ok, payload) {
    const msg = ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload };
    self.postMessage(msg);
  }
  emitProgress(id, progress) {
    const msg = { id, type: "progress", progress };
    self.postMessage(msg);
  }
};

// src/lib/sql-tokenizer.ts
var KEYWORD_CHAR_RE = /[A-Za-z0-9_]/;
var IDENT_START_RE = /[A-Za-z_]/;
var DIGIT_RE = /[0-9]/;
var WHITESPACE_RE = /\s/;
var PUNCTUATION = /* @__PURE__ */ new Set(["(", ")", ",", ";", ".", "[", "]", ":", "*"]);
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = sql.length;
  const push = (t) => tokens.push(t);
  while (i < n) {
    const ch = sql[i];
    if (ch === "\n") {
      push({ type: "newline", text: "\n", start: i, end: i + 1, line });
      line++;
      i++;
      continue;
    }
    if (WHITESPACE_RE.test(ch)) {
      let j = i + 1;
      while (j < n && WHITESPACE_RE.test(sql[j]) && sql[j] !== "\n") j++;
      push({ type: "whitespace", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push({ type: "comment-line", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (sql[j] === "\n") {
          line++;
          j++;
        } else {
          j++;
        }
      }
      push({ type: "comment-block", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (sql[j] === "\n") line++;
        j++;
      }
      const text = sql.slice(i, j);
      const value = text.slice(1, -1).replace(/''/g, "'");
      push({ type: "string", text, start: i, end: j, line, value });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (sql[j] === "\n") line++;
        j++;
      }
      const text = sql.slice(i, j);
      const value = text.slice(1, -1).replace(/""/g, '"');
      push({ type: "quoted-identifier", text, start: i, end: j, line, value });
      i = j;
      continue;
    }
    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const j = closeIdx < 0 ? n : closeIdx + tag.length;
        for (let k = i; k < j; k++) if (sql[k] === "\n") line++;
        push({ type: "dollar-quote", text: sql.slice(i, j), start: i, end: j, line, value: tag });
        i = j;
        continue;
      }
    }
    if (DIGIT_RE.test(ch) || ch === "." && DIGIT_RE.test(sql[i + 1] ?? "")) {
      let j = i;
      if (ch === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(sql[j])) j++;
      } else {
        while (j < n && (DIGIT_RE.test(sql[j]) || sql[j] === ".")) j++;
        if (sql[j] === "e" || sql[j] === "E") {
          j++;
          if (sql[j] === "+" || sql[j] === "-") j++;
          while (j < n && DIGIT_RE.test(sql[j])) j++;
        }
      }
      push({ type: "number", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }
    if (IDENT_START_RE.test(ch)) {
      let j = i + 1;
      while (j < n && KEYWORD_CHAR_RE.test(sql[j])) j++;
      const text = sql.slice(i, j);
      const upper = text.toUpperCase();
      const isKeyword = KEYWORDS.has(upper);
      push({
        type: isKeyword ? "keyword" : "identifier",
        text,
        start: i,
        end: j,
        line,
        value: text
      });
      i = j;
      continue;
    }
    if (ch === "-" && sql[i + 1] === ">") {
      let len = 2;
      if (sql[i + 2] === ">") len = 3;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if (ch === "#" && sql[i + 1] === ">") {
      let len = 2;
      if (sql[i + 2] === ">") len = 3;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if ("<>!=".includes(ch)) {
      let len = 1;
      if (sql[i + 1] === "=") len = 2;
      if (ch === "<" && sql[i + 1] === ">" || ch === "!" && sql[i + 1] === "=") len = 2;
      if (ch === "|" && sql[i + 1] === "|") len = 2;
      push({ type: "operator", text: sql.slice(i, i + len), start: i, end: i + len, line });
      i += len;
      continue;
    }
    if (ch === "|" && sql[i + 1] === "|") {
      push({ type: "operator", text: "||", start: i, end: i + 2, line });
      i += 2;
      continue;
    }
    if (ch === ":" && sql[i + 1] === ":") {
      push({ type: "operator", text: "::", start: i, end: i + 2, line });
      i += 2;
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }
    if ("+-*/%<>=~&|^@?".includes(ch)) {
      push({ type: "operator", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }
    push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
    i++;
  }
  push({ type: "eof", text: "", start: n, end: n, line });
  return tokens;
}
function significantTokens(tokens) {
  return tokens.filter(
    (t) => t.type !== "whitespace" && t.type !== "newline" && t.type !== "comment-line" && t.type !== "comment-block"
  );
}
function splitStatements(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "eof") {
      if (cur.length) out.push(cur);
      break;
    }
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === ";" && depth === 0) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
var KEYWORDS = /* @__PURE__ */ new Set([
  // Reserved
  "ALL",
  "ANALYSE",
  "ANALYZE",
  "AND",
  "ANY",
  "ARRAY",
  "AS",
  "ASC",
  "ASYMMETRIC",
  "AUTHORIZATION",
  "BINARY",
  "BOTH",
  "CASE",
  "CAST",
  "CHECK",
  "COLLATE",
  "COLLATION",
  "COLUMN",
  "CONCURRENTLY",
  "CONSTRAINT",
  "CREATE",
  "CROSS",
  "CURRENT_CATALOG",
  "CURRENT_DATE",
  "CURRENT_ROLE",
  "CURRENT_SCHEMA",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURRENT_USER",
  "DEFAULT",
  "DEFERRABLE",
  "DESC",
  "DISTINCT",
  "DO",
  "ELSE",
  "END",
  "EXCEPT",
  "FALSE",
  "FETCH",
  "FOR",
  "FOREIGN",
  "FREEZE",
  "FROM",
  "FULL",
  "GRANT",
  "GROUP",
  "HAVING",
  "ILIKE",
  "IN",
  "INITIALLY",
  "INNER",
  "INTERSECT",
  "INTO",
  "IS",
  "ISNULL",
  "JOIN",
  "LATERAL",
  "LEADING",
  "LEFT",
  "LIKE",
  "LIMIT",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "NATURAL",
  "NOT",
  "NOTNULL",
  "NULL",
  "OFFSET",
  "ON",
  "ONLY",
  "OR",
  "ORDER",
  "OUTER",
  "OVERLAPS",
  "PLACING",
  "PRIMARY",
  "REFERENCES",
  "RETURNING",
  "RIGHT",
  "SELECT",
  "SESSION_USER",
  "SIMILAR",
  "SOME",
  "SYMMETRIC",
  "TABLE",
  "TABLESAMPLE",
  "THEN",
  "TO",
  "TRAILING",
  "TRUE",
  "UNION",
  "UNIQUE",
  "USER",
  "USING",
  "VARIADIC",
  "VERBOSE",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
  // Non-reserved but commonly used
  "ABORT",
  "ABSOLUTE",
  "ACCESS",
  "ACTION",
  "ADD",
  "ADMIN",
  "AFTER",
  "AGGREGATE",
  "ALSO",
  "ALTER",
  "ALWAYS",
  "ASSERTION",
  "ASSIGNMENT",
  "AT",
  "ATTACH",
  "ATTRIBUTE",
  "BACKWARD",
  "BEFORE",
  "BEGIN",
  "BY",
  "CACHE",
  "CALL",
  "CALLED",
  "CASCADE",
  "CASCADED",
  "CATALOG",
  "CHAIN",
  "CHARACTERISTICS",
  "CHECKPOINT",
  "CLASS",
  "CLOSE",
  "CLUSTER",
  "COLUMNS",
  "COMMENT",
  "COMMENTS",
  "COMMIT",
  "COMMITTED",
  "COMPRESSION",
  "CONFIGURATION",
  "CONFLICT",
  "CONNECTION",
  "CONSTRAINTS",
  "CONTENT",
  "CONTINUE",
  "CONVERSION",
  "COPY",
  "COST",
  "CSV",
  "CUBE",
  "CURRENT",
  "CURSOR",
  "CYCLE",
  "DATA",
  "DATABASE",
  "DAY",
  "DAYS",
  "DEALLOCATE",
  "DECLARE",
  "DEFAULTS",
  "DEFERRED",
  "DEFINER",
  "DELETE",
  "DELIMITER",
  "DELIMITERS",
  "DEPENDS",
  "DETACH",
  "DICTIONARY",
  "DISABLE",
  "DISCARD",
  "DOCUMENT",
  "DOMAIN",
  "DOUBLE",
  "DROP",
  "EACH",
  "ENABLE",
  "ENCODING",
  "ENCRYPTED",
  "ENUM",
  "ESCAPE",
  "EVENT",
  "EXCLUDE",
  "EXCLUDING",
  "EXCLUSIVE",
  "EXECUTE",
  "EXISTS",
  "EXPLAIN",
  "EXPRESSION",
  "EXTENSION",
  "EXTERNAL",
  "FAMILY",
  "FILTER",
  "FIRST",
  "FOLLOWING",
  "FORCE",
  "FORWARD",
  "FUNCTION",
  "FUNCTIONS",
  "GLOBAL",
  "GRANTED",
  "HANDLER",
  "HEADER",
  "HOLD",
  "HOUR",
  "HOURS",
  "IDENTITY",
  "IF",
  "IMMEDIATE",
  "IMMUTABLE",
  "IMPLICIT",
  "IMPORT",
  "INCLUDE",
  "INCLUDING",
  "INCREMENT",
  "INDEX",
  "INDEXES",
  "INHERIT",
  "INHERITS",
  "INLINE",
  "INPUT",
  "INSENSITIVE",
  "INSERT",
  "INSTEAD",
  "INVOKER",
  "ISOLATION",
  "JSON",
  "JSONB",
  "KEY",
  "LABEL",
  "LANGUAGE",
  "LARGE",
  "LAST",
  "LEAKPROOF",
  "LEVEL",
  "LISTEN",
  "LOAD",
  "LOCAL",
  "LOCATION",
  "LOCK",
  "LOCKED",
  "LOGGED",
  "MAPPING",
  "MATCH",
  "MATCHED",
  "MATERIALIZED",
  "MAXVALUE",
  "METHOD",
  "MINUTE",
  "MINUTES",
  "MINVALUE",
  "MODE",
  "MONTH",
  "MONTHS",
  "MOVE",
  "NAME",
  "NAMES",
  "NEW",
  "NEXT",
  "NO",
  "NOTHING",
  "NOTIFY",
  "NOWAIT",
  "NULLS",
  "OBJECT",
  "OF",
  "OFF",
  "OIDS",
  "OLD",
  "OPERATOR",
  "OPTION",
  "OPTIONS",
  "OVER",
  "OVERRIDING",
  "OWNED",
  "OWNER",
  "PARALLEL",
  "PARSER",
  "PARTIAL",
  "PARTITION",
  "PASSING",
  "PASSWORD",
  "PERSISTENT",
  "PLANS",
  "POLICY",
  "PRECEDING",
  "PRECISION",
  "PREPARE",
  "PREPARED",
  "PRESERVE",
  "PRIOR",
  "PRIVILEGES",
  "PROCEDURAL",
  "PROCEDURE",
  "PROCEDURES",
  "PROGRAM",
  "PUBLICATION",
  "QUOTE",
  "RANGE",
  "READ",
  "REAL",
  "REASSIGN",
  "RECHECK",
  "RECURSIVE",
  "REF",
  "REFERENCING",
  "REFRESH",
  "REINDEX",
  "RELATIVE",
  "RELEASE",
  "RENAME",
  "REPEATABLE",
  "REPLACE",
  "REPLICA",
  "RESET",
  "RESTART",
  "RESTRICT",
  "RETURN",
  "REVOKE",
  "ROLE",
  "ROLLBACK",
  "ROLLUP",
  "ROUTINE",
  "ROUTINES",
  "ROW",
  "ROWS",
  "RULE",
  "SAVEPOINT",
  "SCHEMA",
  "SCHEMAS",
  "SCROLL",
  "SEARCH",
  "SECOND",
  "SECONDS",
  "SECRET",
  "SECURITY",
  "SEQUENCE",
  "SEQUENCES",
  "SERIALIZABLE",
  "SERVER",
  "SESSION",
  "SET",
  "SETS",
  "SHARE",
  "SHOW",
  "SIMPLE",
  "SKIP",
  "SNAPSHOT",
  "SQL",
  "STABLE",
  "STANDALONE",
  "START",
  "STATEMENT",
  "STATISTICS",
  "STDIN",
  "STDOUT",
  "STORAGE",
  "STORED",
  "STRICT",
  "STRIP",
  "SUBSCRIPTION",
  "SYSID",
  "SYSTEM",
  "TABLES",
  "TABLESPACE",
  "TEMP",
  "TEMPLATE",
  "TEMPORARY",
  "TEXT",
  "TRANSACTION",
  "TRANSFORM",
  "TRIGGER",
  "TRUNCATE",
  "TRUSTED",
  "TYPE",
  "TYPES",
  "UNBOUNDED",
  "UNCOMMITTED",
  "UNENCRYPTED",
  "UNKNOWN",
  "UNLISTEN",
  "UNLOGGED",
  "UNTIL",
  "UPDATE",
  "VACUUM",
  "VALID",
  "VALIDATE",
  "VALIDATOR",
  "VALUE",
  "VARIABLE",
  "VARYING",
  "VERSION",
  "VIEW",
  "VIEWS",
  "VIRTUAL",
  "VOLATILE",
  "WHITESPACE",
  "WITHIN",
  "WITHOUT",
  "WORK",
  "WRAPPER",
  "WRITE",
  "XML",
  "YEAR",
  "YEARS",
  "YES",
  "ZONE"
]);

// src/lib/sql-reference.ts
var SQL_KEYWORDS = [
  { label: "SELECT", insertText: "SELECT " },
  { label: "FROM", insertText: "FROM " },
  { label: "WHERE", insertText: "WHERE " },
  { label: "JOIN", insertText: "JOIN " },
  { label: "INNER JOIN", insertText: "INNER JOIN " },
  { label: "LEFT JOIN", insertText: "LEFT JOIN " },
  { label: "RIGHT JOIN", insertText: "RIGHT JOIN " },
  { label: "FULL JOIN", insertText: "FULL JOIN " },
  { label: "CROSS JOIN", insertText: "CROSS JOIN " },
  { label: "ON", insertText: "ON " },
  { label: "USING", insertText: "USING " },
  { label: "GROUP BY", insertText: "GROUP BY " },
  { label: "ORDER BY", insertText: "ORDER BY " },
  { label: "HAVING", insertText: "HAVING " },
  { label: "LIMIT", insertText: "LIMIT " },
  { label: "OFFSET", insertText: "OFFSET " },
  { label: "AS", insertText: "AS " },
  { label: "DISTINCT", insertText: "DISTINCT " },
  { label: "AND", insertText: "AND " },
  { label: "OR", insertText: "OR " },
  { label: "NOT", insertText: "NOT " },
  { label: "NULL", insertText: "NULL" },
  { label: "TRUE", insertText: "TRUE" },
  { label: "FALSE", insertText: "FALSE" },
  { label: "IN", insertText: "IN " },
  { label: "NOT IN", insertText: "NOT IN " },
  { label: "EXISTS", insertText: "EXISTS " },
  { label: "BETWEEN", insertText: "BETWEEN " },
  { label: "LIKE", insertText: "LIKE " },
  { label: "ILIKE", insertText: "ILIKE " },
  { label: "IS NULL", insertText: "IS NULL" },
  { label: "IS NOT NULL", insertText: "IS NOT NULL" },
  { label: "WITH", insertText: "WITH " },
  { label: "UNION", insertText: "UNION " },
  { label: "UNION ALL", insertText: "UNION ALL " },
  { label: "INTERSECT", insertText: "INTERSECT " },
  { label: "EXCEPT", insertText: "EXCEPT " },
  { label: "INSERT INTO", insertText: "INSERT INTO " },
  { label: "VALUES", insertText: "VALUES " },
  { label: "UPDATE", insertText: "UPDATE " },
  { label: "SET", insertText: "SET " },
  { label: "DELETE FROM", insertText: "DELETE FROM " },
  { label: "RETURNING", insertText: "RETURNING " },
  { label: "CASE", insertText: "CASE " },
  { label: "WHEN", insertText: "WHEN " },
  { label: "THEN", insertText: "THEN " },
  { label: "ELSE", insertText: "ELSE " },
  { label: "END", insertText: "END" },
  { label: "CAST", insertText: "CAST" },
  { label: "ASC", insertText: "ASC" },
  { label: "DESC", insertText: "DESC" },
  { label: "FETCH FIRST", insertText: "FETCH FIRST " },
  { label: "ROWS ONLY", insertText: "ROWS ONLY" }
];
var BUILTIN_FUNCTIONS = [
  { name: "count", returnType: "bigint", argsDescription: "(*) | (expr)", detail: "Number of rows" },
  { name: "sum", returnType: "numeric", argsDescription: "(expr)", detail: "Sum of values" },
  { name: "avg", returnType: "numeric", argsDescription: "(expr)", detail: "Average of values" },
  { name: "min", returnType: "any", argsDescription: "(expr)", detail: "Minimum value" },
  { name: "max", returnType: "any", argsDescription: "(expr)", detail: "Maximum value" },
  { name: "coalesce", returnType: "any", argsDescription: "(expr, ...)", detail: "First non-null argument" },
  { name: "nullif", returnType: "any", argsDescription: "(a, b)", detail: "NULL if a = b" },
  { name: "now", returnType: "timestamptz", argsDescription: "()", detail: "Current timestamp" },
  { name: "current_timestamp", returnType: "timestamptz", argsDescription: "()", detail: "Current timestamp" },
  { name: "current_date", returnType: "date", argsDescription: "()", detail: "Current date" },
  { name: "current_time", returnType: "time", argsDescription: "()", detail: "Current time" },
  { name: "length", returnType: "int", argsDescription: "(text)", detail: "String length" },
  { name: "char_length", returnType: "int", argsDescription: "(text)", detail: "String length" },
  { name: "lower", returnType: "text", argsDescription: "(text)", detail: "Lowercase" },
  { name: "upper", returnType: "text", argsDescription: "(text)", detail: "Uppercase" },
  { name: "trim", returnType: "text", argsDescription: "(text)", detail: "Trim whitespace" },
  { name: "substring", returnType: "text", argsDescription: "(text, from, for)", detail: "Extract substring" },
  { name: "substr", returnType: "text", argsDescription: "(text, from, for)", detail: "Extract substring" },
  { name: "replace", returnType: "text", argsDescription: "(text, from, to)", detail: "Replace occurrences" },
  { name: "concat", returnType: "text", argsDescription: "(*, ...)", detail: "Concatenate strings" },
  { name: "to_char", returnType: "text", argsDescription: "(value, fmt)", detail: "Format value to text" },
  { name: "to_date", returnType: "date", argsDescription: "(text, fmt)", detail: "Parse date" },
  { name: "to_timestamp", returnType: "timestamptz", argsDescription: "(text, fmt)", detail: "Parse timestamp" },
  { name: "to_number", returnType: "numeric", argsDescription: "(text, fmt)", detail: "Parse number" },
  { name: "extract", returnType: "numeric", argsDescription: "(field FROM source)", detail: "Extract date part" },
  { name: "date_trunc", returnType: "timestamptz", argsDescription: "(field, ts)", detail: "Truncate to field" },
  { name: "date_part", returnType: "numeric", argsDescription: "(field, ts)", detail: "Get date part" },
  { name: "age", returnType: "interval", argsDescription: "(ts[, ts2])", detail: "Time interval" },
  { name: "round", returnType: "numeric", argsDescription: "(num[, dp])", detail: "Round" },
  { name: "ceil", returnType: "numeric", argsDescription: "(num)", detail: "Ceiling" },
  { name: "floor", returnType: "numeric", argsDescription: "(num)", detail: "Floor" },
  { name: "abs", returnType: "numeric", argsDescription: "(num)", detail: "Absolute value" },
  { name: "generate_series", returnType: "setof", argsDescription: "(start, stop[, step])", detail: "Series" },
  { name: "jsonb_build_object", returnType: "jsonb", argsDescription: "(*, ...)", detail: "Build jsonb" },
  { name: "jsonb_agg", returnType: "jsonb", argsDescription: "(expr)", detail: "Aggregate to jsonb array" },
  { name: "jsonb_object_agg", returnType: "jsonb", argsDescription: "(k, v)", detail: "Aggregate to jsonb object" },
  { name: "jsonb_extract_path_text", returnType: "text", argsDescription: "(jb, keys...)", detail: "Extract path as text" },
  { name: "jsonb_extract_path", returnType: "jsonb", argsDescription: "(jb, keys...)", detail: "Extract path as jsonb" },
  { name: "array_agg", returnType: "anyarray", argsDescription: "(expr)", detail: "Aggregate to array" },
  { name: "string_agg", returnType: "text", argsDescription: "(expr, delim)", detail: "Aggregate to string" },
  { name: "bool_or", returnType: "bool", argsDescription: "(expr)", detail: "Logical OR aggregate" },
  { name: "bool_and", returnType: "bool", argsDescription: "(expr)", detail: "Logical AND aggregate" },
  { name: "row_number", returnType: "bigint", argsDescription: "() OVER", detail: "Window row number" },
  { name: "rank", returnType: "bigint", argsDescription: "() OVER", detail: "Window rank" },
  { name: "dense_rank", returnType: "bigint", argsDescription: "() OVER", detail: "Window dense rank" },
  { name: "lag", returnType: "any", argsDescription: "(expr[, off[, default]]) OVER", detail: "Window previous row" },
  { name: "lead", returnType: "any", argsDescription: "(expr[, off[, default]]) OVER", detail: "Window next row" },
  { name: "exists", returnType: "bool", argsDescription: "(subquery)", detail: "Subquery existence" }
];
function normalizeType(type) {
  const trimmed = type.trim().toLowerCase();
  const arrMatch = trimmed.match(/^(.+?)\s*(?:\[\s*\])+$/);
  let core = trimmed;
  let isArray = false;
  if (arrMatch) {
    core = arrMatch[1].trim();
    isArray = true;
  }
  core = core.replace(/\s*\([^)]*\)\s*$/, "").trim();
  core = core.replace(/\s+with(out)?\s+time\s+zone$/, "").trim();
  const alias = {
    int: "integer",
    int4: "integer",
    int8: "bigint",
    int2: "smallint",
    serial: "integer",
    bigserial: "bigint",
    smallserial: "smallint",
    bool: "boolean",
    decimal: "numeric",
    float: "double precision",
    float8: "double precision",
    float4: "real",
    "character varying": "varchar",
    char: "bpchar",
    character: "bpchar",
    timestamp: "timestamptz",
    json: "jsonb"
  };
  return { baseType: alias[core] ?? core, isArray, original: type };
}
function typesComparable(a, b) {
  const ba = normalizeType(a).baseType;
  const bb = normalizeType(b).baseType;
  if (ba === bb) return true;
  const numeric = /* @__PURE__ */ new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);
  if (numeric.has(ba) && numeric.has(bb)) return true;
  const text = /* @__PURE__ */ new Set(["text", "varchar", "bpchar", "name"]);
  if (text.has(ba) && text.has(bb)) return true;
  const ts = /* @__PURE__ */ new Set(["timestamptz", "timestamp", "date", "time"]);
  if (ts.has(ba) && ts.has(bb)) return true;
  const json = /* @__PURE__ */ new Set(["json", "jsonb"]);
  if (json.has(ba) && json.has(bb)) return true;
  return false;
}

// src/types/schema-graph.ts
function foldKey(name, quoted) {
  return quoted ? name : name.toLowerCase();
}
function relationKey(schema, name, schemaQuoted = false, nameQuoted = false) {
  return `${foldKey(schema, schemaQuoted)}.${foldKey(name, nameQuoted)}`;
}

// src/lib/jsonb-parser.ts
var ANNOT_PREFIX = "@pg4-jsonb";
function extractJsonbAnnotations(rawDdl) {
  const annotations = [];
  const warnings = [];
  const lines = rawDdl.split("\n");
  lines.forEach((lineText, idx) => {
    const line = lineText.trim();
    if (!line.startsWith("--")) return;
    const afterDashes = line.slice(2).trim();
    if (!afterDashes.startsWith(ANNOT_PREFIX)) return;
    const rest = afterDashes.slice(ANNOT_PREFIX.length).trim();
    const parsed = parseOneAnnotation(rest, idx + 1, lineText);
    if ("error" in parsed) {
      warnings.push({
        line: idx + 1,
        excerpt: truncate(lineText, 120),
        code: "jsonb-annotation",
        message: parsed.error
      });
      return;
    }
    annotations.push(parsed);
  });
  return { annotations, warnings };
}
function parseOneAnnotation(rest, lineNo, raw) {
  let comment;
  let core = rest;
  const quotedComment = core.match(/"([^"]*)"\s*$/);
  if (quotedComment) {
    comment = quotedComment[1];
    core = core.slice(0, quotedComment.index).trim();
  }
  const firstSpace = core.search(/\s/);
  if (firstSpace < 0) {
    return { error: "missing path specification" };
  }
  const target = core.slice(0, firstSpace).trim();
  const pathType = core.slice(firstSpace + 1).trim();
  const targetParts = target.split(".");
  if (targetParts.length !== 3 || targetParts.some((p) => !p)) {
    return { error: `invalid target "${target}", expected schema.table.column` };
  }
  const [schema, table, column] = targetParts;
  const colonIdx = pathType.lastIndexOf(":");
  let pathStr;
  let valueType;
  if (colonIdx < 0) {
    pathStr = pathType;
  } else {
    pathStr = pathType.slice(0, colonIdx).trim();
    valueType = pathType.slice(colonIdx + 1).trim() || void 0;
  }
  if (!pathStr) {
    return { error: "empty path" };
  }
  const segments = parsePathSegments(pathStr, lineNo, raw);
  if (segments.length === 0) {
    return { error: "could not parse path segments" };
  }
  return { schema, table, column, segments, valueType, comment };
}
function parsePathSegments(pathStr, lineNo, raw) {
  const segments = [];
  if (pathStr.startsWith("/")) {
    const parts2 = pathStr.split("/").slice(1);
    for (const p of parts2) {
      const seg = p.replace(/~1/g, "/").replace(/~0/g, "~");
      if (seg === "" || seg === "-") continue;
      segments.push(seg);
    }
    return segments;
  }
  const parts = pathStr.split(".");
  for (const p of parts) {
    if (!p) continue;
    segments.push(p);
  }
  return segments;
}
function buildJsonbTree(annotations) {
  const warnings = [];
  const roots = [];
  for (const ann of annotations) {
    let level = roots;
    for (let i = 0; i < ann.segments.length; i++) {
      const segRaw = ann.segments[i];
      const isArray = segRaw.endsWith("[]");
      const name = isArray ? segRaw.slice(0, -2) : segRaw;
      if (!name) {
        warnings.push({
          line: 0,
          excerpt: ann.segments.join("."),
          code: "jsonb-path",
          message: `empty segment in path "${ann.segments.join(".")}"`
        });
        break;
      }
      const isLeaf = i === ann.segments.length - 1;
      let node = level.find((n) => n.displayPath === name || lastSegment(n) === name);
      if (!node) {
        node = {
          segments: [],
          displayPath: name,
          isArray,
          valueType: isLeaf ? ann.valueType ?? "unknown" : void 0,
          nullable: void 0,
          comment: isLeaf ? ann.comment : void 0,
          children: []
        };
        level.push(node);
      } else if (isLeaf) {
        node.valueType = ann.valueType ?? node.valueType ?? "unknown";
        if (ann.comment) node.comment = ann.comment;
        if (isArray) node.isArray = true;
      } else {
        if (isArray) node.isArray = true;
      }
      level = node.children;
    }
  }
  const finalize = (nodes, prefix) => {
    for (const n of nodes) {
      n.segments = [...prefix, n.displayPath + (n.isArray ? "[]" : "")];
      n.displayPath = n.segments.map((s) => s.replace(/\[\]$/, "")).join(".");
      finalize(n.children, n.segments);
    }
  };
  finalize(roots, []);
  return { roots, warnings };
}
function lastSegment(node) {
  return node.displayPath.split(".").pop() ?? node.displayPath;
}
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n) + "\u2026";
}

// src/lib/ddl-parser.ts
var DDL_PARSER_VERSION = 1;
function parseDdl(rawDdl, snapshotId, displayName, sourceFileName) {
  const graph = {
    snapshotId,
    displayName,
    sourceFileName,
    importedAt: (/* @__PURE__ */ new Date()).toISOString(),
    parserVersion: DDL_PARSER_VERSION,
    schemas: {},
    functions: []
  };
  const ctx = { graph, warnings: [] };
  const { annotations, warnings: annotWarnings } = extractJsonbAnnotations(rawDdl);
  ctx.warnings.push(...annotWarnings);
  const annotationsByColumn = /* @__PURE__ */ new Map();
  for (const a of annotations) {
    const k = `${a.schema.toLowerCase()}.${a.table.toLowerCase()}.${a.column.toLowerCase()}`;
    const arr = annotationsByColumn.get(k) ?? [];
    arr.push(a);
    annotationsByColumn.set(k, arr);
  }
  const tokens = tokenize(rawDdl);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  for (const stmt of statements) {
    if (stmt.length === 0) continue;
    try {
      parseStatement(stmt, ctx);
    } catch (e) {
      ctx.warnings.push({
        line: stmt[0]?.line ?? 0,
        excerpt: tokensFor(stmt).slice(0, 120),
        code: "statement-error",
        message: e?.message ?? String(e)
      });
    }
  }
  for (const [colKey, anns] of annotationsByColumn) {
    const [schema, table, column] = colKey.split(".");
    const rel = lookupRelation(ctx.graph, schema, table);
    if (!rel) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`
      });
      continue;
    }
    const col = rel.columns.find((c) => c.key === column);
    if (!col) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`
      });
      continue;
    }
    if (col.baseType !== "jsonb" && col.baseType !== "json") {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-type",
        message: `@pg4-jsonb on non-JSON column ${col.dataType} ${schema}.${table}.${column}`
      });
    }
    const { roots, warnings: treeWarnings } = buildJsonbTree(anns);
    col.jsonbPaths = roots;
    ctx.warnings.push(...treeWarnings);
  }
  return { graph, warnings: ctx.warnings };
}
function tokensFor(stmt) {
  return stmt.map((t) => t.text).join("");
}
function parseStatement(stmt, ctx) {
  const kw = upperAt(stmt, 0);
  if (kw === "CREATE") parseCreate(stmt, ctx);
  else if (kw === "ALTER") parseAlter(stmt, ctx);
  else if (kw === "COMMENT") parseComment(stmt, ctx);
  else if (kw === "SET" || kw === "SELECT" || kw === "INSERT" || kw === "UPDATE" || kw === "DELETE") {
  } else if (kw === "GRANT" || kw === "REVOKE") {
  } else {
    ctx.warnings.push({
      line: stmt[0]?.line ?? 0,
      excerpt: tokensFor(stmt).slice(0, 120),
      code: "unsupported-statement",
      message: `unsupported statement starting with "${kw}"`
    });
  }
}
function parseCreate(stmt, ctx) {
  let i = 1;
  i = skipOrReplace(stmt, i);
  if (upperAt(stmt, i) === "UNLOGGED" || upperAt(stmt, i) === "TEMP" || upperAt(stmt, i) === "TEMPORARY") i++;
  const obj = upperAt(stmt, i);
  switch (obj) {
    case "SCHEMA":
      parseCreateSchema(stmt, i + 1, ctx);
      break;
    case "TABLE":
      parseCreateTable(stmt, i + 1, ctx);
      break;
    case "VIEW":
      parseCreateRelation(stmt, i + 1, "view", ctx);
      break;
    case "MATERIALIZED":
      if (upperAt(stmt, i + 1) === "VIEW") parseCreateRelation(stmt, i + 2, "materialized-view", ctx);
      else unsupported(stmt, ctx, obj);
      break;
    case "FOREIGN":
      if (upperAt(stmt, i + 1) === "TABLE") parseCreateRelation(stmt, i + 2, "foreign-table", ctx);
      else unsupported(stmt, ctx, obj);
      break;
    case "UNIQUE":
    case "INDEX":
      parseCreateIndex(stmt, i, ctx);
      break;
    case "FUNCTION":
    case "PROCEDURE":
      parseCreateFunction(stmt, i + 1, ctx);
      break;
    default:
      unsupported(stmt, ctx, obj);
  }
}
function skipOrReplace(stmt, i) {
  if (upperAt(stmt, i) === "OR" && upperAt(stmt, i + 1) === "REPLACE") return i + 2;
  return i;
}
function parseCreateSchema(stmt, start, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const nameTok = stmt[i];
  if (!nameTok || nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier") {
    ctx.warnings.push(warn(stmt, "schema-name", "expected schema name"));
    return;
  }
  const quoted = nameTok.type === "quoted-identifier";
  const name = nameTok.value ?? nameTok.text;
  ensureSchema(ctx.graph, name, quoted);
}
function parseCreateTable(stmt, start, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  i = end;
  const paren = stmt[i];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") {
    ctx.warnings.push(warn(stmt, "table-no-body", `CREATE TABLE ${relName} without column list`));
    return;
  }
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) {
    ctx.warnings.push(warn(stmt, "unbalanced-parens", "unbalanced parentheses in CREATE TABLE"));
    return;
  }
  const innerTokens = stmt.slice(i + 1, closeIdx);
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const table = {
    kind: "table",
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: []
  };
  schema.relations[table.key] = table;
  parseTableBody(innerTokens, table, ctx);
  for (const col of table.columns) {
    if (table.primaryKey.some((pk) => pk.toLowerCase() === col.key.toLowerCase())) col.isPrimaryKey = true;
  }
}
function parseCreateRelation(stmt, start, kind, ctx) {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const rel = {
    kind,
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: []
  };
  schema.relations[rel.key] = rel;
  if (kind === "foreign-table") {
    const paren = stmt[end];
    if (paren && paren.type === "punctuation" && paren.text === "(") {
      const closeIdx = findMatchingParen(stmt, end);
      if (closeIdx > 0) parseTableBody(stmt.slice(end + 1, closeIdx), rel, ctx);
    }
  }
}
function parseTableBody(inner, table, ctx) {
  const items = splitTopLevelCommas(inner);
  for (const item of items) {
    if (item.length === 0) continue;
    const leadingKw = upperAt(item, 0);
    if (leadingKw === "CONSTRAINT") {
      parseTableConstraint(item, 1, table, ctx);
    } else if (leadingKw === "PRIMARY" && upperAt(item, 1) === "KEY") {
      parsePrimaryKeyConstraint(item, 2, table, ctx);
    } else if (leadingKw === "UNIQUE") {
      parseUniqueConstraint(item, 1, table, ctx);
    } else if (leadingKw === "FOREIGN" && upperAt(item, 1) === "KEY") {
      parseForeignKeyConstraint(item, 2, table, ctx);
    } else if (leadingKw === "CHECK") {
    } else if (leadingKw === "EXCLUDE") {
    } else {
      parseColumnDef(item, table, ctx);
    }
  }
}
function parseColumnDef(item, table, ctx) {
  const nameTok = item[0];
  if (!nameTok || nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier") {
    ctx.warnings.push(warn(item, "column-name", "expected column name"));
    return;
  }
  const quoted = nameTok.type === "quoted-identifier";
  const name = nameTok.value ?? nameTok.text;
  const typeEnd = findColumnOptionStart(item, 1);
  const typeTokens = item.slice(1, typeEnd);
  if (typeTokens.length === 0) {
    ctx.warnings.push(warn(item, "column-type", `column ${name} has no type`));
    return;
  }
  const dataType = typeTokens.map((t) => t.text).join("").trim();
  const { baseType, isArray } = normalizeType(dataType);
  const col = {
    name,
    key: foldKey(name, quoted),
    quoted,
    dataType,
    baseType: isArray ? `${baseType}[]` : baseType,
    nullable: true,
    ordinal: table.columns.length + 1,
    isPrimaryKey: false
  };
  for (let i = typeEnd; i < item.length; i++) {
    const kw = upperAt(item, i);
    switch (kw) {
      case "NOT":
        if (upperAt(item, i + 1) === "NULL") {
          col.nullable = false;
          i++;
        }
        break;
      case "NULL":
        col.nullable = true;
        break;
      case "DEFAULT":
        col.defaultExpression = tokensFor(item.slice(i + 1)).trim() || void 0;
        i = item.length;
        break;
      case "PRIMARY":
        if (upperAt(item, i + 1) === "KEY") {
          col.isPrimaryKey = true;
          if (!table.primaryKey.includes(name)) table.primaryKey.push(name);
          i++;
        }
        break;
      case "UNIQUE":
        break;
      case "REFERENCES":
      case "FOREIGN": {
        const refStart = kw === "FOREIGN" ? i + 1 : i;
        const fk = parseReferences(item, refStart + 1, table, ctx);
        if (fk) {
          col.foreignKey = fk;
          i = fk._endIndex ?? i;
          delete fk._endIndex;
        }
        break;
      }
      case "GENERATED":
        break;
      case "CHECK":
        i = item.length;
        break;
      case "COLLATE":
        i++;
        break;
    }
  }
  table.columns.push(col);
}
function parseReferences(item, start, table, ctx) {
  const { schemaName, relName, end } = readQualifiedName(item, start, ctx);
  if (!relName) return null;
  let i = end;
  let cols = [];
  const openTok = item[i];
  if (openTok && openTok.type === "punctuation" && openTok.text === "(") {
    const closeIdx = findMatchingParen(item, i);
    if (closeIdx > 0) {
      cols = splitTopLevelCommas(item.slice(i + 1, closeIdx)).map((p) => p.map((t) => t.text).join("")).map((s) => s.trim()).filter(Boolean);
      i = closeIdx + 1;
    }
  }
  while (i < item.length) {
    const kw = upperAt(item, i);
    if (kw === "ON" || kw === "MATCH" || kw === "DEFERRABLE" || kw === "INITIALLY" || kw === "NOT") {
      i++;
    } else {
      break;
    }
  }
  const fk = {
    name: void 0,
    localColumns: [],
    referencedSchema: schemaName,
    referencedTable: relName,
    referencedColumns: cols,
    _endIndex: i - 1
  };
  return fk;
}
function parseTableConstraint(stmt, start, table, ctx) {
  const nameTok = stmt[start];
  let i = start + 1;
  const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : void 0;
  const kw = upperAt(stmt, i);
  if (kw === "PRIMARY" && upperAt(stmt, i + 1) === "KEY") {
    parsePrimaryKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "UNIQUE") {
    parseUniqueConstraint(stmt, i + 1, table, ctx, constraintName);
  } else if (kw === "FOREIGN" && upperAt(stmt, i + 1) === "KEY") {
    parseForeignKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "CHECK" || kw === "EXCLUDE") {
  }
}
function parsePrimaryKeyConstraint(stmt, start, table, ctx, name) {
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.primaryKey = Array.from(/* @__PURE__ */ new Set([...table.primaryKey, ...cols]));
}
function parseUniqueConstraint(stmt, start, table, ctx, name) {
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.indexes.push({
    name: name ?? `__unique_${table.indexes.length}`,
    columns: cols,
    unique: true
  });
}
function parseForeignKeyConstraint(stmt, start, table, ctx, name) {
  const localCols = readParenColumns(stmt, start);
  let i = skipParen(stmt, start);
  if (upperAt(stmt, i) !== "REFERENCES") return;
  i++;
  const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const refCols = readParenColumns(stmt, end);
  table.foreignKeys.push({
    name,
    localColumns: localCols,
    referencedSchema: schemaName,
    referencedTable: relName,
    referencedColumns: refCols
  });
  for (const lc of localCols) {
    const col = table.columns.find((c) => c.key === lc.toLowerCase());
    if (col && !col.foreignKey) {
      col.foreignKey = {
        name,
        localColumns: localCols,
        referencedSchema: schemaName,
        referencedTable: relName,
        referencedColumns: refCols
      };
    }
  }
}
function readParenColumns(stmt, start) {
  const paren = stmt[start];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") return [];
  const closeIdx = findMatchingParen(stmt, start);
  if (closeIdx < 0) return [];
  const inner = stmt.slice(start + 1, closeIdx);
  return splitTopLevelCommas(inner).map((p) => p.map((t) => t.text).join("").trim()).map((s) => s.replace(/["']/g, "")).filter(Boolean);
}
function skipParen(stmt, start) {
  if (stmt[start]?.text === "(") {
    const closeIdx = findMatchingParen(stmt, start);
    return closeIdx < 0 ? start + 1 : closeIdx + 1;
  }
  return start;
}
function findColumnOptionStart(item, from) {
  const stopKws = /* @__PURE__ */ new Set([
    "NOT",
    "NULL",
    "DEFAULT",
    "PRIMARY",
    "UNIQUE",
    "REFERENCES",
    "FOREIGN",
    "CHECK",
    "GENERATED",
    "COLLATE",
    "CONSTRAINT"
  ]);
  let depth = 0;
  for (let i = from; i < item.length; i++) {
    const t = item[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth--;
    if (depth === 0 && t.type === "keyword" && stopKws.has(t.text.toUpperCase())) {
      return i;
    }
  }
  return item.length;
}
function parseCreateIndex(stmt, start, ctx) {
  let i = start;
  let unique = false;
  if (upperAt(stmt, i) === "UNIQUE") {
    unique = true;
    i++;
  }
  if (upperAt(stmt, i) !== "INDEX") return;
  i++;
  if (upperAt(stmt, i) === "CONCURRENTLY") i++;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const nameTok = stmt[i];
  if (nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier")) {
    i++;
  }
  if (upperAt(stmt, i) === "ON") i++;
  const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const rel = lookupRelation(ctx.graph, schemaName, relName);
  if (!rel) {
    ctx.warnings.push(warn(stmt, "index-target-missing", `CREATE INDEX on unknown table ${schemaName}.${relName}`));
    return;
  }
  const cols = readParenColumns(stmt, end);
  const isPartial = stmt.slice(end).some((t) => t.type === "keyword" && t.text.toUpperCase() === "WHERE");
  let name = `__index_${rel.indexes.length}`;
  for (let k = end - 1; k >= 0; k--) {
    const tk = stmt[k];
    if (tk && (tk.type === "identifier" || tk.type === "quoted-identifier")) {
      name = tk.value ?? tk.text;
      break;
    }
  }
  rel.indexes.push({ name, columns: cols, unique, partial: isPartial });
}
function parseCreateFunction(stmt, start, ctx) {
  let i = start;
  i = skipOrReplace(stmt, i);
  const { schemaName, relName: fnName, schemaQuoted, relQuoted: fnQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!fnName) return;
  i = end;
  const argsOpenTok = stmt[i];
  if (!argsOpenTok || argsOpenTok.text !== "(") return;
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) return;
  const argsTokens = stmt.slice(i + 1, closeIdx);
  const args = parseFunctionArgs(argsTokens);
  i = closeIdx + 1;
  let returnType = "void";
  if (upperAt(stmt, i) === "RETURNS") {
    i++;
    if (upperAt(stmt, i) === "SETOF") i++;
    const typeTokens = [];
    while (i < stmt.length) {
      const kw = upperAt(stmt, i);
      if (kw === "LANGUAGE" || kw === "AS" || kw === "WINDOW" || kw === "STRICT" || kw === "VOLATILE" || kw === "STABLE" || kw === "IMMUTABLE" || kw === "SECURITY" || kw === "PARALLEL" || kw === "COST" || kw === "ROWS") break;
      typeTokens.push(stmt[i]);
      i++;
    }
    returnType = typeTokens.map((t) => t.text).join("").trim() || returnType;
  }
  let language;
  while (i < stmt.length) {
    if (upperAt(stmt, i) === "LANGUAGE") {
      language = stmt[i + 1]?.text;
      i += 2;
    } else i++;
  }
  const fn = {
    schema: schemaName,
    name: fnName,
    key: `${schemaName.toLowerCase()}.${fnName.toLowerCase()}`,
    args,
    returnType,
    language,
    quoted: fnQuoted
  };
  ctx.graph.functions.push(fn);
}
function parseFunctionArgs(tokens) {
  const args = [];
  if (tokens.length === 0) return args;
  const parts = splitTopLevelCommas(tokens);
  for (const part of parts) {
    if (part.length === 0) continue;
    let mode = "in";
    let j = 0;
    const first = upperAt(part, 0);
    if (first === "IN") {
      mode = "in";
      j = 1;
    } else if (first === "OUT") {
      mode = "out";
      j = 1;
    } else if (first === "INOUT") {
      mode = "inout";
      j = 1;
    } else if (first === "VARIADIC") {
      mode = "variadic";
      j = 1;
    }
    let name;
    let dataType;
    const nameTok = part[j];
    const typeTok = part[j + 1];
    if (nameTok && typeTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") && typeTok.type !== "punctuation") {
      name = nameTok.value ?? nameTok.text;
      dataType = part.slice(j + 1).map((t) => t.text).join("").trim();
    } else {
      dataType = part.slice(j).map((t) => t.text).join("").trim();
    }
    let defaultVal;
    const defIdx = part.findIndex((t) => t.type === "keyword" && t.text.toUpperCase() === "DEFAULT");
    if (defIdx >= 0) {
      defaultVal = part.slice(defIdx + 1).map((t) => t.text).join("").trim() || void 0;
      dataType = part.slice(j, defIdx).filter((t) => !(t.type === "keyword" && t.text.toUpperCase() === "DEFAULT")).map((t) => t.text).join("").trim();
    }
    if (!dataType) continue;
    args.push({ name, dataType, mode, default: defaultVal });
  }
  return args;
}
function parseAlter(stmt, ctx) {
  const obj = upperAt(stmt, 1);
  if (obj === "TABLE") {
    let i = 2;
    if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "EXISTS") i += 2;
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    i = end;
    const action = upperAt(stmt, i);
    if (action === "ADD") {
      let j = i + 1;
      if (upperAt(stmt, j) === "CONSTRAINT") {
        const nameTok = stmt[j + 1];
        const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : void 0;
        const typeKw = upperAt(stmt, j + 2);
        if (typeKw === "PRIMARY" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parsePrimaryKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        } else if (typeKw === "UNIQUE") {
          if (rel) parseUniqueConstraint(stmt, j + 3, rel, ctx, constraintName);
        } else if (typeKw === "FOREIGN" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parseForeignKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        }
      } else {
        const typeKw = upperAt(stmt, j);
        if (typeKw === "PRIMARY" && upperAt(stmt, j + 1) === "KEY") {
          if (rel) parsePrimaryKeyConstraint(stmt, j + 2, rel, ctx);
        } else if (typeKw === "UNIQUE") {
          if (rel) parseUniqueConstraint(stmt, j + 1, rel, ctx);
        } else if (typeKw === "FOREIGN" && upperAt(stmt, j + 1) === "KEY") {
          if (rel) parseForeignKeyConstraint(stmt, j + 2, rel, ctx);
        }
      }
    } else if (action === "ALTER" && upperAt(stmt, i + 1) === "COLUMN") {
      const colTok = stmt[i + 2];
      if (!colTok || !rel) return;
      const colName = (colTok.value ?? colTok.text).toLowerCase();
      const col = rel.columns.find((c) => c.key === colName);
      if (!col) return;
      const op = upperAt(stmt, i + 3);
      if (op === "SET" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = stmt.slice(i + 5).map((t) => t.text).join("").trim() || void 0;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = void 0;
      } else if (op === "SET" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = false;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = true;
      } else if (op === "TYPE" || op === "SET" && upperAt(stmt, i + 4) === "DATA" && upperAt(stmt, i + 5) === "TYPE") {
        const typeStart = op === "TYPE" ? i + 4 : i + 6;
        const newType = stmt.slice(typeStart).map((t) => t.text).join("").trim().replace(/USING.*$/i, "").trim();
        if (newType) {
          const { baseType, isArray } = normalizeType(newType);
          col.dataType = newType;
          col.baseType = isArray ? `${baseType}[]` : baseType;
        }
      }
    }
  }
}
function parseComment(stmt, ctx) {
  const obj = upperAt(stmt, 2);
  let i = 3;
  if (obj === "TABLE") {
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    if (rel) {
      const comment = readStringLiteral(stmt, end);
      if (comment != null) rel.comment = comment;
    }
  } else if (obj === "COLUMN") {
    const { schemaName, relName, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    let j = end;
    let colName;
    const dotTok = stmt[j];
    const colTok = stmt[j + 1];
    if (dotTok && dotTok.text === "." && colTok) {
      colName = (colTok.value ?? colTok.text).toLowerCase();
      j += 2;
    }
    if (!colName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName);
    if (rel) {
      const col = rel.columns.find((c) => c.key === colName);
      if (col) {
        const comment = readStringLiteral(stmt, j);
        if (comment != null) col.comment = comment;
      }
    }
  }
}
function readStringLiteral(stmt, from) {
  for (let i = from; i < stmt.length; i++) {
    if (stmt[i].type === "string") return (stmt[i].value ?? "") || "";
  }
  return null;
}
function readQualifiedName(stmt, from, ctx) {
  let schemaName = "public";
  let schemaQuoted = false;
  let relName = "";
  let relQuoted = false;
  let i = from;
  const first = stmt[i];
  if (!first || first.type !== "identifier" && first.type !== "quoted-identifier") {
    return { schemaName, relName, schemaQuoted, relQuoted, end: from };
  }
  const firstName = first.value ?? first.text;
  const firstQuoted = first.type === "quoted-identifier";
  const dotTok = stmt[i + 1];
  const relTok = stmt[i + 2];
  if (dotTok && dotTok.text === "." && relTok && (relTok.type === "identifier" || relTok.type === "quoted-identifier")) {
    schemaName = firstName;
    schemaQuoted = firstQuoted;
    relName = relTok.value ?? relTok.text;
    relQuoted = relTok.type === "quoted-identifier";
    i += 3;
  } else {
    relName = firstName;
    relQuoted = firstQuoted;
    i += 1;
  }
  return { schemaName, relName, schemaQuoted, relQuoted, end: i };
}
function ensureSchema(graph, name, quoted) {
  const key = foldKey(name, quoted);
  let s = graph.schemas[key];
  if (!s) {
    s = { name, key, quoted, relations: {} };
    graph.schemas[key] = s;
  }
  return s;
}
function lookupRelation(graph, schemaName, relName) {
  const sk = schemaName.toLowerCase();
  const rk = `${sk}.${relName.toLowerCase()}`;
  return graph.schemas[sk]?.relations[rk] ?? null;
}
function splitTopLevelCommas(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function findMatchingParen(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function upperAt(stmt, i) {
  if (i < 0 || i >= stmt.length) return "";
  return stmt[i].text.toUpperCase();
}
function warn(stmt, code, message) {
  return {
    line: stmt[0]?.line ?? 0,
    excerpt: tokensFor(stmt).slice(0, 120),
    code,
    message
  };
}
function unsupported(stmt, ctx, obj) {
  ctx.warnings.push(warn(stmt, "unsupported-create", `unsupported CREATE ${obj}`));
}

// src/lib/schema-index.ts
function buildIndex(graph) {
  const index = { relations: {}, columns: {} };
  for (const schema of Object.values(graph.schemas)) {
    for (const rel of Object.values(schema.relations)) {
      const bareKey = rel.name.toLowerCase();
      const qualifiedKey = rel.key;
      (index.relations[bareKey] ??= []).push(qualifiedKey);
      const qualifiedKey2 = qualifiedKey;
      const cols = rel.columns.map((c) => c.key);
      index.columns[qualifiedKey2] = cols;
    }
  }
  return index;
}
function lookupSchemas(graph, prefix) {
  const lower = prefix.toLowerCase();
  return Object.values(graph.schemas).filter((s) => s.name.toLowerCase().startsWith(lower)).map((s) => s.name);
}
function getRelation(graph, schema, name, schemaQuoted = false, nameQuoted = false) {
  const sk = foldKey(schema, schemaQuoted);
  const nk = foldKey(name, nameQuoted);
  return graph.schemas[sk]?.relations[`${sk}.${nk}`] ?? null;
}

// src/lib/context-parser.ts
function buildCompletionContext(input) {
  const { sql, cursor } = input;
  if (cursor < 0 || cursor > sql.length) {
    return unknownContext(0, 0, "");
  }
  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  const stmt = findStatementAtCursor(tokens, cursor, statements, sig);
  if (!stmt) {
    return unknownContext(0, 0, "");
  }
  const relationMap = buildRelationMap(stmt.tokens, input.graph);
  const { kind, from, to, prefix } = classifyCursor(stmt, cursor, sql, relationMap, input.graph);
  return {
    kind,
    from,
    to,
    prefix,
    activeAlias: relationMap.activeAlias,
    activeRelation: relationMap.activeRelation,
    visibleRelations: relationMap.visibleRelations,
    expectedTypes: relationMap.expectedTypes,
    jsonb: relationMap.jsonb
  };
}
function findStatementAtCursor(allTokens, cursor, statements, sig) {
  if (sig.length === 0) return null;
  let idx = 0;
  const stmtSpans = [];
  let cur = [];
  let depth = 0;
  let stmtStart = sig[0].start;
  for (const t of sig) {
    if (t.type === "eof") {
      if (cur.length) stmtSpans.push({ start: stmtStart, end: t.start, tokens: cur });
      break;
    }
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === ";" && depth === 0) {
      if (cur.length) stmtSpans.push({ start: stmtStart, end: t.end, tokens: cur });
      cur = [];
      stmtStart = sig[idx + 1]?.start ?? t.end;
    } else {
      if (cur.length === 0) stmtStart = t.start;
      cur.push(t);
    }
    idx++;
  }
  if (cur.length) stmtSpans.push({ start: stmtStart, end: sig[sig.length - 1]?.start ?? cur[cur.length - 1].end, tokens: cur });
  for (const span of stmtSpans) {
    if (cursor >= span.start && cursor <= span.end + 1) {
      return { tokens: span.tokens, start: span.start };
    }
  }
  const last = stmtSpans[stmtSpans.length - 1];
  if (last) return { tokens: last.tokens, start: last.start };
  return null;
}
function buildRelationMap(stmt, graph) {
  const map = { visibleRelations: [] };
  collectCtesAndRelations(stmt, graph, map);
  return map;
}
function collectCtesAndRelations(stmt, graph, map) {
  const cteColumns = /* @__PURE__ */ new Map();
  let i = 0;
  if (upperAt2(stmt, 0) === "WITH") {
    i = 1;
    if (upperAt2(stmt, i) === "RECURSIVE") i++;
    while (i < stmt.length) {
      const nameTok = stmt[i];
      if (!nameTok || nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier") break;
      const cteName = nameTok.value ?? nameTok.text;
      let j = i + 1;
      let declaredCols;
      const openTok = stmt[j];
      if (openTok && openTok.text === "(") {
        const closeIdx2 = findMatchingParen2(stmt, j);
        if (closeIdx2 > 0) {
          declaredCols = splitTopLevelCommas2(stmt.slice(j + 1, closeIdx2)).map((p) => p.map((t) => t.text).join("").trim()).filter(Boolean).map((name) => ({ name, key: name.toLowerCase() }));
          j = closeIdx2 + 1;
        }
      }
      if (upperAt2(stmt, j) !== "AS") break;
      j++;
      const openTok2 = stmt[j];
      if (!openTok2 || openTok2.text !== "(") break;
      const closeIdx = findMatchingParen2(stmt, j);
      if (closeIdx < 0) break;
      const inner = stmt.slice(j + 1, closeIdx);
      const cols = declaredCols ?? extractCteProjection(inner, graph);
      cteColumns.set(cteName.toLowerCase(), cols);
      i = closeIdx + 1;
      const nextTok = stmt[i];
      if (nextTok && nextTok.text === ",") {
        i++;
        continue;
      }
      break;
    }
  }
  for (let k = 0; k < stmt.length; k++) {
    const kw = upperAt2(stmt, k);
    if (kw === "FROM" || kw === "JOIN" || kw === "UPDATE" || kw === "INTO") {
      const isJoin = kw === "JOIN";
      let m = k + 1;
      while (upperAt2(stmt, m) === "INNER" || upperAt2(stmt, m) === "LEFT" || upperAt2(stmt, m) === "RIGHT" || upperAt2(stmt, m) === "FULL" || upperAt2(stmt, m) === "CROSS" || upperAt2(stmt, m) === "OUTER" || upperAt2(stmt, m) === "LATERAL") m++;
      const rel = parseRelationRef(stmt, m, graph, cteColumns);
      if (rel) {
        let next = rel.endIndex + 1;
        if (upperAt2(stmt, next) === "AS") next++;
        const aliasTok = stmt[next];
        if (aliasTok && (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier") && !KEYWORDS.has(aliasTok.text.toUpperCase())) {
          rel.alias = aliasTok.value ?? aliasTok.text;
        }
        map.visibleRelations.push(rel);
        k = rel.endIndex + (rel.alias ? stmt[rel.endIndex + 1]?.text === "AS" ? 2 : 1 : 0);
      }
    }
  }
}
function parseRelationRef(stmt, from, graph, cteColumns) {
  const t = stmt[from];
  if (!t) return null;
  if (t.text === "(") {
    const closeIdx = findMatchingParen2(stmt, from);
    if (closeIdx < 0) return null;
    const cols = extractCteProjection(stmt.slice(from + 1, closeIdx), graph);
    return {
      key: `__subquery_${from}`,
      name: "",
      columns: cols,
      endIndex: closeIdx
    };
  }
  if (t.type !== "identifier" && t.type !== "quoted-identifier") return null;
  const firstName = t.value ?? t.text;
  const dotTok = stmt[from + 1];
  const relTok = stmt[from + 2];
  if (dotTok && dotTok.text === "." && relTok && (relTok.type === "identifier" || relTok.type === "quoted-identifier")) {
    const relName = relTok.value ?? relTok.text;
    const rel = graph ? getRelation(graph, firstName, relName, t.type === "quoted-identifier", relTok.type === "quoted-identifier") : null;
    return {
      key: `${firstName.toLowerCase()}.${relName.toLowerCase()}`,
      schema: firstName,
      name: relName,
      columns: rel ? rel.columns.map(columnToRef) : void 0,
      endIndex: from + 2
    };
  }
  const bareKey = firstName.toLowerCase();
  if (cteColumns.has(bareKey)) {
    return {
      key: bareKey,
      name: firstName,
      cteName: firstName,
      columns: cteColumns.get(bareKey),
      endIndex: from
    };
  }
  if (graph) {
    const rel = getRelation(graph, "public", firstName, false, t.type === "quoted-identifier");
    if (rel) {
      return {
        key: `public.${bareKey}`,
        schema: "public",
        name: firstName,
        columns: rel.columns.map(columnToRef),
        endIndex: from
      };
    }
    for (const sName of Object.keys(graph.schemas)) {
      const r = getRelation(graph, sName, firstName, false, t.type === "quoted-identifier");
      if (r) {
        return {
          key: `${sName}.${bareKey}`,
          schema: sName,
          name: firstName,
          columns: r.columns.map(columnToRef),
          endIndex: from
        };
      }
    }
  }
  return { key: bareKey, name: firstName, endIndex: from };
}
function columnToRef(c) {
  return {
    name: c.name,
    key: c.key,
    dataType: c.dataType,
    baseType: c.baseType,
    isPrimaryKey: c.isPrimaryKey,
    isForeignKey: !!c.foreignKey,
    jsonb: c.baseType === "jsonb" || c.baseType === "json"
  };
}
function extractCteProjection(innerTokens, graph) {
  const kwSelect = upperAt2(innerTokens, 0);
  if (kwSelect !== "SELECT" && kwSelect !== "TABLE" && kwSelect !== "VALUES") return [];
  if (kwSelect === "VALUES") return [];
  if (kwSelect === "TABLE") {
    const ref = innerTokens[1];
    if (!ref) return [];
    const rel = graph ? resolveRelationByName(innerTokens, 1, graph) : null;
    return rel?.columns.map(columnToRef) ?? [];
  }
  const fromIdx = findTopLevelKeyword(innerTokens, "FROM", 1);
  const projEnd = fromIdx < 0 ? innerTokens.length : fromIdx;
  const proj = innerTokens.slice(1, projEnd);
  const parts = splitTopLevelCommas2(proj);
  const cols = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (part.length === 1 && part[0].text === "*") continue;
    if (part.length === 3 && part[1].text === "." && part[2].text === "*") continue;
    const asIdx = part.findIndex((t) => t.type === "keyword" && t.text.toUpperCase() === "AS");
    if (asIdx >= 0 && asIdx + 1 < part.length) {
      const aliasTok = part[asIdx + 1];
      if (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier") {
        const nm = aliasTok.value ?? aliasTok.text;
        cols.push({ name: nm, key: nm.toLowerCase() });
        continue;
      }
    }
    const lastId = [...part].reverse().find((t) => t.type === "identifier" || t.type === "quoted-identifier");
    if (lastId) {
      const nm = lastId.value ?? lastId.text;
      cols.push({ name: nm, key: nm.toLowerCase() });
    }
  }
  return cols;
}
function resolveRelationByName(tokens, at, graph) {
  const t = tokens[at];
  if (!t) return null;
  const dotTok = tokens[at + 1];
  const relTok = tokens[at + 2];
  if (dotTok && dotTok.text === "." && relTok) {
    return getRelation(graph, t.value ?? t.text, relTok.value ?? relTok.text, t.type === "quoted-identifier", relTok.type === "quoted-identifier");
  }
  return getRelation(graph, "public", t.value ?? t.text, false, t.type === "quoted-identifier") ?? findRelationAnySchema(graph, t.value ?? t.text);
}
function findRelationAnySchema(graph, name) {
  const lower = name.toLowerCase();
  for (const s of Object.values(graph.schemas)) {
    for (const r of Object.values(s.relations)) {
      if (r.name.toLowerCase() === lower) return r;
    }
  }
  return null;
}
function classifyCursor(stmt, cursor, sql, map, graph) {
  const sig = significantTokensBefore(stmt.tokens, cursor);
  if (sig.length === 0) {
    return { kind: "keyword", from: cursor, to: cursor, prefix: "" };
  }
  const prev = sig[sig.length - 1];
  const prevPrev = sig[sig.length - 2];
  const prevText = prev.text;
  const prevUpper = prevText.toUpperCase();
  if (prevText === "->" || prevText === "->>" || prevText === "#>" || prevText === "#>>") {
    const colTok = prevPrev;
    if (colTok) {
      const rel = resolveRelationForPrefix(stmt.tokens, colTok, map);
      const column = (colTok.value ?? colTok.text).toLowerCase();
      if (rel) {
        map.jsonb = {
          relation: rel,
          column,
          operator: prevText
        };
      }
    }
    return { kind: "jsonb-path", from: cursor, to: cursor, prefix: "" };
  }
  if (prevText === ".") {
    const qualifierTok = prevPrev;
    if (qualifierTok) {
      const qualifier = qualifierTok.value ?? qualifierTok.text;
      const qualifierUpper = qualifier.toUpperCase();
      const aliasRel = map.visibleRelations.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase());
      if (aliasRel) {
        map.activeAlias = qualifier;
        map.activeRelation = aliasRel;
        return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
      }
      const relByName = map.visibleRelations.find((r) => r.name.toLowerCase() === qualifier.toLowerCase());
      if (relByName) {
        map.activeRelation = relByName;
        return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
      }
      if (graph && lookupSchemas(graph, qualifier).length > 0) {
        return { kind: "schema", from: cursor, to: cursor, prefix: "" };
      }
    }
    return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
  }
  if (isRelationContextKeyword(prevUpper)) {
    return { kind: "relation", from: cursor, to: cursor, prefix: "" };
  }
  if (prevText === "(" && prevPrev && (prevPrev.text.toUpperCase() === "INTO" || isRelationNameToken(prevPrev))) {
    return { kind: "insert-column", from: cursor, to: cursor, prefix: "" };
  }
  if (prevUpper === "VALUES") {
    return { kind: "insert-value", from: cursor, to: cursor, prefix: "" };
  }
  if (prevUpper === "AS" && prevPrev && prevPrev.type !== "punctuation") {
    return { kind: "relation", from: cursor, to: cursor, prefix: "" };
  }
  if (prevUpper === "WITH") {
    return { kind: "cte-name", from: cursor, to: cursor, prefix: "" };
  }
  if (prev.type === "identifier" || prev.type === "quoted-identifier") {
    const from = prev.start;
    const to = cursor;
    const prefix = sql.slice(from, cursor);
    const before = sig[sig.length - 2];
    const beforeUpper = before ? before.text.toUpperCase() : "";
    if (beforeUpper === ".") {
      return { kind: "qualified-column", from, to, prefix };
    }
    if (isRelationContextKeyword(beforeUpper)) {
      return { kind: "relation", from, to, prefix };
    }
    if (beforeUpper === "VALUES") {
      return { kind: "insert-value", from, to, prefix };
    }
    return { kind: "column", from, to, prefix };
  }
  if (prevText === ",") {
    return { kind: "column", from: cursor, to: cursor, prefix: "" };
  }
  if (isColumnContextKeyword(prevUpper)) {
    return { kind: "column", from: cursor, to: cursor, prefix: "" };
  }
  return { kind: "unknown", from: cursor, to: cursor, prefix: "" };
}
function significantTokensBefore(stmtTokens, cursor) {
  const sig = significantTokens(stmtTokens).filter((t) => t.start < cursor);
  return sig;
}
function resolveRelationForPrefix(stmtTokens, colTok, map) {
  const idx = stmtTokens.indexOf(colTok);
  if (idx >= 2 && stmtTokens[idx - 1].text === ".") {
    const qualifier = stmtTokens[idx - 2];
    const qName = qualifier.value ?? qualifier.text;
    const aliasRel = map.visibleRelations.find((r) => r.alias?.toLowerCase() === qName.toLowerCase() || r.name.toLowerCase() === qName.toLowerCase());
    if (aliasRel) return aliasRel;
  }
  if (map.visibleRelations.length === 1) return map.visibleRelations[0];
  return void 0;
}
function isRelationContextKeyword(kw) {
  return kw === "FROM" || kw === "JOIN" || kw === "INTO" || kw === "UPDATE" || kw === "TABLE";
}
function isColumnContextKeyword(kw) {
  return kw === "SELECT" || kw === "WHERE" || kw === "ON" || kw === "GROUP" || kw === "ORDER" || kw === "HAVING" || kw === "BY" || kw === "AND" || kw === "OR" || kw === "RETURNING" || kw === "SET";
}
function isRelationNameToken(t) {
  return t.type === "identifier" || t.type === "quoted-identifier";
}
function unknownContext(from, to, prefix) {
  return {
    kind: "unknown",
    from,
    to,
    prefix,
    visibleRelations: []
  };
}
function findMatchingParen2(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitTopLevelCommas2(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function findTopLevelKeyword(tokens, kw, from) {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === "keyword" && t.text.toUpperCase() === kw) return i;
  }
  return -1;
}
function upperAt2(stmt, i) {
  if (i < 0 || i >= stmt.length) return "";
  return stmt[i].text.toUpperCase();
}

// src/lib/completion-ranker.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
var RECENCY_WINDOW_DAYS = 30;
function computeScore(item, inputs) {
  const M = prefixMatchScore(inputs.prefix, item.filterText || item.label);
  const R = recencyScore(item, inputs);
  const F = frequencyScore(item, inputs);
  const L = localScore(item, inputs);
  const K = keynessScore(item, inputs);
  const D = contextMatchScore(item, inputs);
  return 0.4 * M + 0.2 * R + 0.15 * F + 0.1 * L + 0.1 * K + 0.05 * D;
}
function prefixMatchScore(prefix, label) {
  if (!prefix) return 0.5;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l === p) return 1;
  if (l.startsWith(p)) return 0.9;
  const segments = l.split(/(?=[A-Z])|[_\s.]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase().startsWith(p))) return 0.7;
  if (fuzzyContains(l, p)) return 0.4;
  return 0;
}
function fuzzyContains(label, prefix) {
  let i = 0;
  for (const ch of label) {
    if (ch === prefix[i]) i++;
    if (i >= prefix.length) return true;
  }
  return i >= prefix.length;
}
function lookupStat(item, inputs) {
  if (!item.usageKey) return void 0;
  return inputs.usage.get(`${inputs.snapshotId}|${item.usageKey.toLowerCase()}`);
}
function recencyScore(item, inputs) {
  const stat = lookupStat(item, inputs);
  if (!stat || !stat.lastUsedAt) return 0;
  const ageDays = (Date.now() - stat.lastUsedAt) / DAY_MS;
  if (ageDays >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - ageDays / RECENCY_WINDOW_DAYS;
}
function frequencyScore(item, inputs) {
  let maxFreq = 0;
  for (const s of inputs.usage.values()) if (s.frequency > maxFreq) maxFreq = s.frequency;
  if (maxFreq === 0) return 0;
  const stat = lookupStat(item, inputs);
  if (!stat) return 0;
  return stat.frequency / maxFreq;
}
function localScore(item, inputs) {
  let maxLocal = 0;
  for (const v2 of inputs.localUsage.values()) if (v2 > maxLocal) maxLocal = v2;
  if (maxLocal === 0) return 0;
  if (!item.usageKey) return 0;
  const v = inputs.localUsage.get(item.usageKey.toLowerCase()) ?? 0;
  return v / maxLocal;
}
function keynessScore(item, inputs) {
  if (!inputs.keySymbolKeys || inputs.keySymbolKeys.size === 0 || !item.usageKey) return 0;
  return inputs.keySymbolKeys.has(item.usageKey.toLowerCase()) ? 1 : 0;
}
function contextMatchScore(item, inputs) {
  if (!inputs.expectedBaseTypes || inputs.expectedBaseTypes.size === 0) return 0.5;
  if (!item.baseType) return 0.5;
  return inputs.expectedBaseTypes.has(normalizeBase(item.baseType)) ? 1 : 0;
}
function normalizeBase(t) {
  return t.toLowerCase().replace(/\[\]$/, "").replace(/\s*\([^)]*\)/g, "").trim();
}
function sortItems(items) {
  const priority = {
    table: 1,
    view: 1,
    cte: 1,
    column: 2,
    function: 3,
    keyword: 4,
    snippet: 5,
    "jsonb-path": 1
  };
  return [...items].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    const pa = priority[a.kind] ?? 9;
    const pb = priority[b.kind] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0;
  });
}

// src/lib/completion-engine.ts
function buildCandidates(ctx, deps) {
  const usageMap = /* @__PURE__ */ new Map();
  for (const s of deps.usage) usageMap.set(`${s.snapshotId}|${s.symbolKey.toLowerCase()}`, s);
  const rankInputs = {
    prefix: ctx.prefix,
    usage: usageMap,
    snapshotId: deps.snapshotId ?? "",
    localUsage: deps.localUsage,
    keySymbolKeys: computeKeySymbols(ctx),
    expectedBaseTypes: ctx.expectedTypes ? new Set(ctx.expectedTypes.map(normalizeBase2)) : void 0
  };
  const candidates = [];
  const graph = deps.graph;
  switch (ctx.kind) {
    case "relation":
      addRelationCandidates(candidates, graph, ctx);
      addSchemaCandidates(candidates, graph, ctx);
      addKeywordCandidates(candidates, ctx, ["FROM", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "AS", "ON", "USING", "WHERE"]);
      break;
    case "schema":
      addSchemaCandidates(candidates, graph, ctx);
      break;
    case "column":
      addColumnCandidates(candidates, ctx, true);
      addFunctionCandidates(candidates, ctx, graph);
      addKeywordCandidates(candidates, ctx, ["AS", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "DESC", "ASC", "DISTINCT"]);
      break;
    case "qualified-column":
      addQualifiedColumnCandidates(candidates, ctx);
      break;
    case "function":
      addFunctionCandidates(candidates, ctx, graph);
      addColumnCandidates(candidates, ctx, true);
      break;
    case "keyword":
      addKeywordCandidates(candidates, ctx, ["SELECT", "FROM", "WHERE", "JOIN", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH", "UNION", "UNION ALL", "SELECT DISTINCT"]);
      break;
    case "cte-name":
      addKeywordCandidates(candidates, ctx, ["AS"]);
      addRelationCandidates(candidates, graph, ctx);
      break;
    case "jsonb-path":
      addJsonbPathCandidates(candidates, ctx, graph);
      break;
    case "insert-column":
      addInsertColumnCandidates(candidates, ctx);
      break;
    case "insert-value":
      addKeywordCandidates(candidates, ctx, ["DEFAULT", "NULL", "TRUE", "FALSE"]);
      addFunctionCandidates(candidates, ctx, graph);
      break;
    case "type":
      addTypeCandidates(candidates, ctx);
      break;
    case "unknown":
    default:
      addColumnCandidates(candidates, ctx, true);
      addFunctionCandidates(candidates, ctx, graph);
      addKeywordCandidates(candidates, ctx, ["SELECT", "FROM", "WHERE", "AND", "OR", "AS", "IN", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL"]);
      break;
  }
  addSnippetCandidates(candidates, ctx, deps.snippets);
  for (const c of candidates) {
    c.score = computeScore(c, rankInputs);
  }
  const sorted = sortItems(candidates).slice(0, deps.maxCandidates);
  const items = sorted.map(({ usageKey: _u, baseType: _b, ...rest }) => rest);
  return { items };
}
function normalizeBase2(t) {
  return t.toLowerCase().replace(/\[\]$/, "").replace(/\s*\([^)]*\)/g, "").trim();
}
function computeKeySymbols(ctx) {
  const keys = /* @__PURE__ */ new Set();
  for (const rel of ctx.visibleRelations) {
    if (rel.columns) {
      for (const c of rel.columns) {
        if (c.isPrimaryKey) keys.add(`${rel.key}.${c.key}`);
        if (c.isForeignKey) keys.add(`${rel.key}.${c.key}`);
      }
    }
  }
  if (ctx.activeRelation?.columns) {
    for (const c of ctx.activeRelation.columns) keys.add(`${ctx.activeRelation.key}.${c.key}`);
  }
  return keys.size ? keys : void 0;
}
function matchesPrefix(label, prefix) {
  if (!prefix) return true;
  return label.toLowerCase().includes(prefix.toLowerCase());
}
function addRelationCandidates(out, graph, ctx) {
  if (!graph) return;
  for (const schema of Object.values(graph.schemas)) {
    for (const rel of Object.values(schema.relations)) {
      const label = rel.schema === "public" ? rel.name : `${rel.schema}.${rel.name}`;
      if (!matchesPrefix(label, ctx.prefix) && !matchesPrefix(rel.name, ctx.prefix)) continue;
      const kind = rel.kind === "table" ? "table" : rel.kind === "view" ? "view" : "table";
      out.push({
        kind,
        label: rel.name,
        detail: `${rel.schema}.${rel.name} (${rel.kind})`,
        documentation: rel.comment,
        insertText: rel.name,
        filterText: rel.name,
        score: 0,
        source: "schema",
        usageKey: rel.key,
        baseType: rel.kind
      });
    }
  }
}
function addSchemaCandidates(out, graph, ctx) {
  if (!graph) return;
  for (const schema of Object.values(graph.schemas)) {
    if (!matchesPrefix(schema.name, ctx.prefix)) continue;
    out.push({
      kind: "keyword",
      label: schema.name,
      detail: "schema",
      insertText: schema.name,
      filterText: schema.name,
      score: 0,
      source: "schema"
    });
  }
}
function addColumnCandidates(out, ctx, includeAllVisible) {
  if (ctx.activeRelation) {
    addColumnsFromRelation(out, ctx.activeRelation, ctx.prefix);
    return;
  }
  if (includeAllVisible) {
    for (const rel of ctx.visibleRelations) addColumnsFromRelation(out, rel, ctx.prefix);
  }
}
function addColumnsFromRelation(out, rel, prefix) {
  if (!rel.columns) {
    return;
  }
  for (const c of rel.columns) {
    if (!matchesPrefix(c.name, prefix)) continue;
    out.push({
      kind: "column",
      label: c.name,
      detail: c.dataType ? `${rel.name ? rel.name + "." : ""}${c.name} ${c.dataType}` : c.name,
      documentation: c.dataType,
      insertText: c.name,
      filterText: c.name,
      score: 0,
      source: "schema",
      usageKey: `${rel.key}.${c.key}`,
      baseType: c.baseType
    });
  }
}
function addQualifiedColumnCandidates(out, ctx) {
  if (ctx.activeRelation) {
    addColumnsFromRelation(out, ctx.activeRelation, ctx.prefix);
  } else if (ctx.activeAlias) {
  }
}
function addFunctionCandidates(out, ctx, graph) {
  for (const fn of BUILTIN_FUNCTIONS) {
    if (!matchesPrefix(fn.name, ctx.prefix)) continue;
    out.push({
      kind: "function",
      label: fn.name,
      detail: `${fn.returnType} ${fn.name}${fn.argsDescription}`,
      documentation: fn.detail,
      insertText: `${fn.name}(`,
      filterText: fn.name,
      score: 0,
      source: "builtin"
    });
  }
  if (graph) {
    for (const fn of graph.functions) {
      if (!matchesPrefix(fn.name, ctx.prefix)) continue;
      const argsSig = fn.args.map((a) => `${a.name ? a.name + " " : ""}${a.dataType}`).join(", ");
      out.push({
        kind: "function",
        label: fn.name,
        detail: `${fn.returnType} ${fn.schema}.${fn.name}(${argsSig})`,
        documentation: fn.comment,
        insertText: `${fn.name}(`,
        filterText: fn.name,
        score: 0,
        source: "schema",
        usageKey: fn.key,
        baseType: fn.returnType
      });
    }
  }
}
function addKeywordCandidates(out, ctx, allowed) {
  const allowedSet = new Set(allowed.map((a) => a.toUpperCase()));
  for (const kw of SQL_KEYWORDS) {
    if (allowedSet.size > 0 && !allowedSet.has(kw.label.toUpperCase())) continue;
    if (!matchesPrefix(kw.label, ctx.prefix)) continue;
    out.push({
      kind: "keyword",
      label: kw.label,
      insertText: kw.insertText ?? kw.label,
      filterText: kw.label,
      score: 0,
      source: "builtin"
    });
  }
}
function addJsonbPathCandidates(out, ctx, graph) {
  if (!ctx.jsonb || !graph) return;
  const { relation, column } = ctx.jsonb;
  const schemaNode = graph.schemas[relation.schema?.toLowerCase() ?? ""];
  let relNode = null;
  if (schemaNode) {
    const rk = `${schemaNode.key}.${relation.name.toLowerCase()}`;
    relNode = schemaNode.relations[rk] ?? null;
  }
  if (!relNode) {
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        if (r.name.toLowerCase() === relation.name.toLowerCase() || r.key === relation.key) {
          relNode = r;
          break;
        }
      }
      if (relNode) break;
    }
  }
  if (!relNode) return;
  const col = relNode.columns.find((c) => c.key.toLowerCase() === column.toLowerCase());
  if (!col || !col.jsonbPaths) return;
  const { operator } = ctx.jsonb;
  const wantJson = operator === "->" || operator === "#>";
  for (const p of flattenJsonbPaths(col.jsonbPaths, wantJson)) {
    if (!matchesPrefix(p.displayPath, ctx.prefix)) continue;
    out.push({
      kind: "jsonb-path",
      label: p.displayPath,
      detail: p.valueType,
      documentation: p.comment,
      insertText: p.insertText,
      filterText: p.displayPath,
      score: 0,
      source: "schema"
    });
  }
}
function flattenJsonbPaths(roots, wantJson) {
  const out = [];
  const walk = (nodes, parentSegments) => {
    for (const n of nodes) {
      const segments = [...parentSegments, n.displayPath + (n.isArray ? "[]" : "")];
      const cleanSegs = segments.map((s) => s.replace(/\[\]$/, ""));
      const isMulti = parentSegments.length > 0;
      const op = wantJson ? isMulti ? "#>" : "->" : isMulti ? "#>>" : "->>";
      const insertText = isMulti ? `${op}'{${cleanSegs.join(",")}}'` : `${op}'${cleanSegs[0]}'`;
      out.push({ displayPath: n.displayPath, valueType: n.valueType, comment: n.comment, insertText });
      if (n.children.length) walk(n.children, segments);
    }
  };
  walk(roots, []);
  return out;
}
function addInsertColumnCandidates(out, ctx) {
  const target = ctx.visibleRelations[0];
  if (target) addColumnsFromRelation(out, target, ctx.prefix);
}
function addTypeCandidates(out, ctx) {
  const commonTypes = [
    "integer",
    "bigint",
    "smallint",
    "numeric",
    "real",
    "double precision",
    "text",
    "varchar",
    "bpchar",
    "boolean",
    "date",
    "timestamptz",
    "timestamp",
    "interval",
    "uuid",
    "json",
    "jsonb",
    "bytea",
    "inet",
    "cidr",
    "macaddr",
    "money",
    "serial",
    "bigserial"
  ];
  for (const t of commonTypes) {
    if (!matchesPrefix(t, ctx.prefix)) continue;
    out.push({ kind: "keyword", label: t, insertText: t, filterText: t, score: 0, source: "builtin" });
  }
}
function addSnippetCandidates(out, ctx, snippets2) {
  for (const s of snippets2) {
    const trigger = `snip:${s.title.toLowerCase()}`;
    if (ctx.prefix && !trigger.includes(ctx.prefix.toLowerCase()) && !s.title.toLowerCase().includes(ctx.prefix.toLowerCase())) {
      if (ctx.prefix && !ctx.prefix.toLowerCase().startsWith("snip:")) continue;
    }
    out.push({
      kind: "snippet",
      label: `snip:${s.title}`,
      detail: s.category,
      documentation: s.description,
      insertText: s.body,
      filterText: `snip:${s.title}`,
      score: 0,
      source: "snippet"
    });
  }
}

// src/lib/diagnostics.ts
function diagnose(input) {
  const diagnostics = [];
  const { sql } = input;
  if (!sql.trim()) return diagnostics;
  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  checkBraceBalance(tokens, diagnostics);
  checkUnclosedStrings(tokens, diagnostics);
  for (const stmt of statements) {
    if (stmt.length === 0) continue;
    checkStatement(stmt, diagnostics, input.graph);
  }
  return dedupe(diagnostics);
}
function checkBraceBalance(tokens, out) {
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "eof") break;
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth < 0) {
        out.push({
          from: t.start,
          to: t.end,
          severity: "error",
          code: "paren-extra-close",
          message: "Unexpected closing parenthesis",
          ruleId: "syntax.paren"
        });
        depth = 0;
      }
    }
  }
  if (depth > 0) {
    let lastOpen = null;
    let d = 0;
    for (const t of tokens) {
      if (t.type === "eof") break;
      if (t.type === "punctuation" && t.text === "(") {
        d++;
        lastOpen = t;
      } else if (t.type === "punctuation" && t.text === ")") {
        d--;
      }
    }
    const from = lastOpen ? lastOpen.start : 0;
    out.push({
      from,
      to: from + 1,
      severity: "error",
      code: "paren-unclosed",
      message: `Unclosed parenthesis (${depth} open)`,
      ruleId: "syntax.paren"
    });
  }
}
function checkUnclosedStrings(tokens, out) {
  for (const t of tokens) {
    if (t.type === "eof") break;
    if (t.type === "string" && !t.text.endsWith("'")) {
      out.push({
        from: t.start,
        to: t.end,
        severity: "error",
        code: "unclosed-string",
        message: "Unclosed string literal",
        ruleId: "syntax.string"
      });
    }
  }
}
function upperAt3(stmt, i) {
  return i >= 0 && i < stmt.length ? stmt[i].text.toUpperCase() : "";
}
function checkStatement(stmt, out, graph) {
  const head = upperAt3(stmt, 0);
  if (head === "INSERT") checkInsert(stmt, out, graph);
  if (head === "SELECT" || head === "UPDATE" || head === "DELETE") checkComparisonTypes(stmt, out, graph);
  checkAliasColumns(stmt, out, graph);
}
function checkInsert(stmt, out, graph) {
  if (!graph) return;
  if (upperAt3(stmt, 1) !== "INTO") return;
  let i = 2;
  let schema = "public";
  let table = "";
  const t0 = stmt[i];
  if (!t0) return;
  if (stmt[i + 1] && stmt[i + 1].text === "." && stmt[i + 2]) {
    schema = t0.value ?? t0.text;
    table = stmt[i + 2].value ?? stmt[i + 2].text;
    i += 3;
  } else {
    table = t0.value ?? t0.text;
    i += 1;
  }
  let cols = [];
  if (stmt[i] && stmt[i].text === "(") {
    const closeIdx2 = findMatchingParen3(stmt, i);
    if (closeIdx2 > 0) {
      cols = splitTopLevelCommas3(stmt.slice(i + 1, closeIdx2)).map((p) => p.map((t) => t.text).join("").trim()).filter(Boolean);
      i = closeIdx2 + 1;
    }
  }
  if (!cols.length) return;
  while (i < stmt.length && upperAt3(stmt, i) !== "VALUES") i++;
  if (upperAt3(stmt, i) !== "VALUES") return;
  i++;
  if (!stmt[i] || stmt[i].text !== "(") return;
  const closeIdx = findMatchingParen3(stmt, i);
  if (closeIdx < 0) return;
  const valuesTokens = stmt.slice(i + 1, closeIdx);
  const valuesCount = splitTopLevelCommas3(valuesTokens).filter((p) => p.length > 0).length;
  if (cols.length !== valuesCount) {
    out.push({
      from: stmt[i].start,
      to: closeIdx + 1,
      severity: "warning",
      code: "insert-arity",
      message: `Column count (${cols.length}) does not match VALUES count (${valuesCount})`,
      ruleId: "type.insert-arity"
    });
  }
  const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`];
  if (!rel) return;
  for (let k = 0; k < cols.length; k++) {
    const col = rel.columns.find((c) => c.key === cols[k].toLowerCase().replace(/["']/g, ""));
    if (!col) {
      out.push({
        from: 0,
        to: 0,
        severity: "warning",
        code: "unknown-column",
        message: `Column "${cols[k]}" does not exist on ${schema}.${table}`,
        ruleId: "type.unknown-column"
      });
      continue;
    }
  }
}
function checkComparisonTypes(stmt, out, graph) {
  if (!graph) return;
  const aliasMap = buildAliasMap(stmt, graph);
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i];
    if (t.text === "=" || t.text === "!=" || t.text === "<>" || t.text === "<" || t.text === ">" || t.text === "<=" || t.text === ">=") {
      const leftTok = stmt[i - 1];
      const rightTok = stmt[i + 1];
      if (!leftTok || !rightTok) continue;
      const leftType = inferType(leftTok, aliasMap, graph);
      const rightType = inferType(rightTok, aliasMap, graph);
      if (leftType && rightType && !typesComparable(leftType, rightType)) {
        if (isNumeric(leftType) !== isNumeric(rightType)) {
          out.push({
            from: leftTok.start,
            to: rightTok.end,
            severity: "warning",
            code: "type-mismatch",
            message: `Possible type mismatch: ${leftType} vs ${rightType}`,
            ruleId: "type.mismatch"
          });
        }
      }
    }
  }
}
function checkAliasColumns(stmt, out, graph) {
  if (!graph) return;
  const aliasMap = buildAliasMap(stmt, graph);
  for (let i = 0; i < stmt.length; i++) {
    if (stmt[i].text === "." && stmt[i - 1] && stmt[i + 1]) {
      const aliasTok = stmt[i - 1];
      const colTok = stmt[i + 1];
      if (colTok.type !== "identifier" && colTok.type !== "quoted-identifier") continue;
      if (aliasTok.type !== "identifier" && aliasTok.type !== "quoted-identifier") continue;
      const alias = (aliasTok.value ?? aliasTok.text).toLowerCase();
      const col = (colTok.value ?? colTok.text).toLowerCase();
      const rel = aliasMap.get(alias);
      if (!rel) continue;
      const exists = rel.columns.some((c) => c.key === col);
      if (!exists) {
        out.push({
          from: aliasTok.start,
          to: colTok.end,
          severity: "warning",
          code: "unknown-alias-column",
          message: `Column "${aliasTok.text}.${colTok.text}" does not exist on ${rel.schema}.${rel.name}`,
          ruleId: "type.unknown-alias-column"
        });
      }
    }
  }
}
function buildAliasMap(stmt, graph) {
  const m = /* @__PURE__ */ new Map();
  for (let i = 0; i < stmt.length; i++) {
    const kw = upperAt3(stmt, i);
    if (kw === "FROM" || kw === "JOIN" || kw === "UPDATE") {
      let j = i + 1;
      while (upperAt3(stmt, j) === "INNER" || upperAt3(stmt, j) === "LEFT" || upperAt3(stmt, j) === "RIGHT" || upperAt3(stmt, j) === "FULL" || upperAt3(stmt, j) === "CROSS" || upperAt3(stmt, j) === "OUTER" || upperAt3(stmt, j) === "LATERAL") j++;
      const t0 = stmt[j];
      if (!t0 || t0.type !== "identifier" && t0.type !== "quoted-identifier") continue;
      let schema = "public";
      let table = "";
      let end = j;
      if (stmt[j + 1] && stmt[j + 1].text === "." && stmt[j + 2]) {
        schema = t0.value ?? t0.text;
        table = stmt[j + 2].value ?? stmt[j + 2].text;
        end = j + 2;
      } else {
        table = t0.value ?? t0.text;
        end = j;
      }
      const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`];
      let a = end + 1;
      if (upperAt3(stmt, a) === "AS") a++;
      const aliasTok = stmt[a];
      if (aliasTok && (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier")) {
        const alias = (aliasTok.value ?? aliasTok.text).toLowerCase();
        if (rel) m.set(alias, rel);
        if (rel) m.set(table.toLowerCase(), rel);
      } else if (rel) {
        m.set(table.toLowerCase(), rel);
      }
    }
  }
  return m;
}
function inferType(tok, aliasMap, graph) {
  if (tok.type === "string") return "text";
  if (tok.type === "number") return "numeric";
  if (tok.type === "identifier" || tok.type === "quoted-identifier") {
    const name = (tok.value ?? tok.text).toLowerCase();
    if (aliasMap.has(name)) return null;
    for (const rel of aliasMap.values()) {
      const col = rel.columns.find((c) => c.key === name);
      if (col) return col.baseType;
    }
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        const col = r.columns.find((c) => c.key === name);
        if (col) return col.baseType;
      }
    }
  }
  return null;
}
function isNumeric(t) {
  const b = normalizeType(t).baseType;
  return ["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(b);
}
function findMatchingParen3(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitTopLevelCommas3(tokens) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punctuation" && t.text === "," && depth === 0) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function dedupe(diagnostics) {
  const sorted = [...diagnostics].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const d of sorted) {
    const prev = out[out.length - 1];
    if (prev && d.from < prev.to) {
      if (d.severity === "error" && prev.severity !== "error") {
        out[out.length - 1] = d;
      }
      continue;
    }
    out.push(d);
  }
  return out;
}

// src/lib/danger-detector.ts
function detectDanger(sql) {
  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  if (statements.length === 0) return { dangerous: false, reasons: [], kind: null };
  for (const stmt of statements) {
    const res = checkStatement2(stmt);
    if (res.dangerous) return res;
  }
  return { dangerous: false, reasons: [], kind: null };
}
function upperAt4(stmt, i) {
  return i >= 0 && i < stmt.length ? stmt[i].text.toUpperCase() : "";
}
function checkStatement2(stmt) {
  const head = upperAt4(stmt, 0);
  switch (head) {
    case "DELETE":
      return checkDelete(stmt);
    case "UPDATE":
      return checkUpdate(stmt);
    case "TRUNCATE":
      return { dangerous: true, reasons: ["TRUNCATE removes all rows without per-row logging"], kind: "TRUNCATE" };
    case "DROP":
      return { dangerous: true, reasons: ["DROP permanently removes a database object"], kind: "DROP" };
    case "ALTER":
      return checkAlter(stmt);
    default:
      return { dangerous: false, reasons: [], kind: null };
  }
}
function checkDelete(stmt) {
  if (!hasValidWhere(stmt)) {
    return { dangerous: true, reasons: ["DELETE without a WHERE clause affects all rows"], kind: "DELETE" };
  }
  if (isTautologicalWhere(stmt)) {
    return { dangerous: true, reasons: ["DELETE has a tautological WHERE (always true)"], kind: "DELETE" };
  }
  return { dangerous: false, reasons: [], kind: null };
}
function checkUpdate(stmt) {
  if (!hasValidWhere(stmt)) {
    return { dangerous: true, reasons: ["UPDATE without a WHERE clause affects all rows"], kind: "UPDATE" };
  }
  if (isTautologicalWhere(stmt)) {
    return { dangerous: true, reasons: ["UPDATE has a tautological WHERE (always true)"], kind: "UPDATE" };
  }
  return { dangerous: false, reasons: [], kind: null };
}
function checkAlter(stmt) {
  for (let i = 0; i < stmt.length; i++) {
    if (upperAt4(stmt, i) === "DROP" && upperAt4(stmt, i + 1) === "COLUMN") {
      return { dangerous: true, reasons: ["ALTER TABLE ... DROP COLUMN is destructive"], kind: "ALTER" };
    }
  }
  return { dangerous: false, reasons: [], kind: null };
}
function hasValidWhere(stmt) {
  const idx = findTopLevelKeyword2(stmt, "WHERE");
  if (idx < 0) return false;
  return stmt.slice(idx + 1).some((t) => t.type !== "punctuation" || t.text !== ";");
}
function isTautologicalWhere(stmt) {
  const idx = findTopLevelKeyword2(stmt, "WHERE");
  if (idx < 0) return false;
  const tail = stmt.slice(idx + 1);
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    const op = tail[i + 1];
    const b = tail[i + 2];
    if (!a || !op || !b) continue;
    if (op.type !== "operator") continue;
    if (op.text !== "=" && op.text !== "!=") continue;
    if (a.type === "number" && b.type === "number" && a.text === b.text) return true;
    if (a.type === "string" && b.type === "string" && a.value === b.value) return true;
  }
  if (tail.length > 0) {
    const first = tail[0];
    if (first.type === "keyword" && first.text.toUpperCase() === "TRUE") {
      const next = tail[1];
      if (!next || next.type === "keyword" && (next.text.toUpperCase() === "AND" || next.text.toUpperCase() === "OR")) return true;
      if (!next) return true;
    }
  }
  return false;
}
function findTopLevelKeyword2(tokens, kw) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === "keyword" && t.text.toUpperCase() === kw) return i;
  }
  return -1;
}

// src/lib/snapshot-diff.ts
var RENAME_SIMILARITY_THRESHOLD = 0.85;
function diffSnapshots(a, b) {
  const nodes = [];
  const summary = { added: 0, removed: 0, modified: 0, renameCandidates: 0 };
  const aSchemas = new Set(Object.keys(a.schemas));
  const bSchemas = new Set(Object.keys(b.schemas));
  for (const sk of bSchemas) {
    if (!aSchemas.has(sk)) {
      const node = { kind: "schema", path: [b.schemas[sk].name], change: "added", children: [] };
      for (const rel of Object.values(b.schemas[sk].relations)) node.children.push(...diffRelationAdded(rel));
      nodes.push(node);
      summary.added++;
    }
  }
  for (const sk of aSchemas) {
    if (!bSchemas.has(sk)) {
      const node = { kind: "schema", path: [a.schemas[sk].name], change: "removed", children: [] };
      for (const rel of Object.values(a.schemas[sk].relations)) node.children.push(...diffRelationRemoved(rel));
      nodes.push(node);
      summary.removed++;
    }
  }
  for (const sk of aSchemas) {
    if (!bSchemas.has(sk)) continue;
    const aSchema = a.schemas[sk];
    const bSchema = b.schemas[sk];
    const schemaNode = { kind: "schema", path: [aSchema.name], change: "modified", children: [] };
    diffRelationsInSchema(aSchema.relations, bSchema.relations, schemaNode, summary);
    if (schemaNode.children && schemaNode.children.length > 0) {
      nodes.push(schemaNode);
    }
  }
  diffFunctions(a.functions, b.functions, nodes, summary);
  return { nodes, summary };
}
function diffRelationsInSchema(aRels, bRels, parent, summary) {
  const aKeys = new Set(Object.keys(aRels));
  const bKeys = new Set(Object.keys(bRels));
  const removedRels = [...aKeys].filter((k) => !bKeys.has(k)).map((k) => aRels[k]);
  const addedRels = [...bKeys].filter((k) => !aKeys.has(k)).map((k) => bRels[k]);
  for (const added of addedRels) {
    parent.children.push({
      kind: "relation",
      path: [added.schema, added.name],
      change: "added",
      children: diffColumns([], added.columns, summary)
    });
    summary.added++;
  }
  for (const removed of removedRels) {
    parent.children.push({
      kind: "relation",
      path: [removed.schema, removed.name],
      change: "removed",
      children: diffColumns(removed.columns, [], summary)
    });
    summary.removed++;
  }
  for (const removed of removedRels) {
    let best = null;
    for (const added of addedRels) {
      if (added.schema !== removed.schema) continue;
      const sim = relationSimilarity(removed, added);
      if (sim >= RENAME_SIMILARITY_THRESHOLD && (!best || sim > best.sim)) best = { rel: added, sim };
    }
    if (best) {
      parent.children.push({
        kind: "relation",
        path: [removed.schema, `${removed.name} -> ${best.rel.name}`],
        change: "rename-candidate",
        similarity: best.sim
      });
      summary.renameCandidates++;
    }
  }
  for (const k of aKeys) {
    if (!bKeys.has(k)) continue;
    const aRel = aRels[k];
    const bRel = bRels[k];
    const relNode = {
      kind: "relation",
      path: [aRel.schema, aRel.name],
      change: "modified",
      children: diffColumns(aRel.columns, bRel.columns, summary)
    };
    const changes = [];
    if (aRel.primaryKey.join(",") !== bRel.primaryKey.join(",")) {
      changes.push({ field: "primaryKey", before: aRel.primaryKey.join(","), after: bRel.primaryKey.join(",") });
    }
    if ((aRel.comment ?? "") !== (bRel.comment ?? "")) {
      changes.push({ field: "comment", before: aRel.comment, after: bRel.comment });
    }
    if (changes.length) {
      relNode.changes = changes;
      summary.modified++;
    }
    if (relNode.children && relNode.children.length > 0 || changes.length) {
      parent.children.push(relNode);
    }
  }
}
function diffColumns(aCols, bCols, summary) {
  const out = [];
  const aMap = new Map(aCols.map((c) => [c.key, c]));
  const bMap = new Map(bCols.map((c) => [c.key, c]));
  for (const b of bCols) {
    if (!aMap.has(b.key)) {
      out.push({ kind: "column", path: [b.name], change: "added" });
      summary.added++;
    }
  }
  for (const a of aCols) {
    if (!bMap.has(a.key)) {
      out.push({ kind: "column", path: [a.name], change: "removed" });
      summary.removed++;
    }
  }
  for (const a of aCols) {
    const b = bMap.get(a.key);
    if (!b) continue;
    const changes = [];
    if (a.dataType !== b.dataType) changes.push({ field: "dataType", before: a.dataType, after: b.dataType });
    if (a.nullable !== b.nullable) changes.push({ field: "nullable", before: String(a.nullable), after: String(b.nullable) });
    if ((a.defaultExpression ?? "") !== (b.defaultExpression ?? "")) changes.push({ field: "default", before: a.defaultExpression, after: b.defaultExpression });
    if ((a.comment ?? "") !== (b.comment ?? "")) changes.push({ field: "comment", before: a.comment, after: b.comment });
    if (a.isPrimaryKey !== b.isPrimaryKey) changes.push({ field: "primaryKey", before: String(a.isPrimaryKey), after: String(b.isPrimaryKey) });
    if (changes.length) {
      out.push({ kind: "column", path: [a.name], change: "modified", changes });
      summary.modified++;
    }
  }
  return out;
}
function diffRelationAdded(rel) {
  return [{ kind: "relation", path: [rel.schema, rel.name], change: "added", children: rel.columns.map((c) => ({ kind: "column", path: [c.name], change: "added" })) }];
}
function diffRelationRemoved(rel) {
  return [{ kind: "relation", path: [rel.schema, rel.name], change: "removed", children: rel.columns.map((c) => ({ kind: "column", path: [c.name], change: "removed" })) }];
}
function diffFunctions(aFns, bFns, nodes, summary) {
  const aMap = new Map(aFns.map((f) => [f.key, f]));
  const bMap = new Map(bFns.map((f) => [f.key, f]));
  for (const b of bFns) {
    if (!aMap.has(b.key)) {
      nodes.push({ kind: "function", path: [b.schema, b.name], change: "added" });
      summary.added++;
    }
  }
  for (const a of aFns) {
    if (!bMap.has(a.key)) {
      nodes.push({ kind: "function", path: [a.schema, a.name], change: "removed" });
      summary.removed++;
    }
  }
  for (const a of aFns) {
    const b = bMap.get(a.key);
    if (!b) continue;
    if (a.returnType !== b.returnType || argsSignature(a.args) !== argsSignature(b.args)) {
      nodes.push({ kind: "function", path: [a.schema, a.name], change: "modified", changes: [{ field: "signature", before: `${a.returnType}(${argsSignature(a.args)})`, after: `${b.returnType}(${argsSignature(b.args)})` }] });
      summary.modified++;
    }
  }
}
function argsSignature(args) {
  return args.map((a) => `${a.mode} ${a.dataType}`).join(",");
}
function relationSimilarity(a, b) {
  const aCols = new Set(a.columns.map((c) => c.key));
  const bCols = new Set(b.columns.map((c) => c.key));
  if (aCols.size === 0 && bCols.size === 0) return 0;
  let inter = 0;
  for (const c of aCols) if (bCols.has(c)) inter++;
  const union = aCols.size + bCols.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  let typeMatches = 0;
  for (const ac of a.columns) {
    const bc = b.columns.find((c) => c.key === ac.key);
    if (bc && ac.baseType === bc.baseType) typeMatches++;
  }
  const typeSim = a.columns.length === 0 ? 0 : typeMatches / a.columns.length;
  return 0.6 * jaccard + 0.4 * typeSim;
}

// src/worker/parser-worker.ts
var server = new WorkerRpcServer();
var activeGraph = null;
var activeSnapshotId = null;
var usageStats = [];
var localUsage = /* @__PURE__ */ new Map();
var snippets = [];
var maxCandidates = 50;
server.handle("ping", async () => ({ pong: true, version: DDL_PARSER_VERSION.toString() }));
server.handle("set-active-graph", async (req) => {
  activeGraph = req.graph;
  localUsage = /* @__PURE__ */ new Map();
  if (activeGraph) {
    activeSnapshotId = activeGraph.snapshotId;
  } else {
    activeSnapshotId = null;
    usageStats = [];
  }
  return { acknowledged: true };
});
server.handle("set-usage", async (req) => {
  usageStats = req.usage ?? [];
  return { acknowledged: true };
});
server.handle("set-snippets", async (req) => {
  snippets = req.snippets ?? [];
  return { acknowledged: true };
});
server.handle("set-config", async (req) => {
  maxCandidates = req.maxCandidates;
  return { acknowledged: true };
});
server.handle("record-usage", async (req) => {
  const k = req.symbolKey.toLowerCase();
  localUsage.set(k, (localUsage.get(k) ?? 0) + 1);
  return { acknowledged: true };
});
server.handle("complete", async (req) => {
  if (!activeGraph && usageStats.length === 0 && snippets.length === 0) {
  }
  const context = buildCompletionContext({ sql: req.sql, cursor: req.cursor, graph: activeGraph });
  const deps = {
    graph: activeGraph,
    usage: usageStats,
    snapshotId: activeSnapshotId,
    localUsage,
    snippets,
    maxCandidates
  };
  const { items } = buildCandidates(context, deps);
  return { items, context };
});
server.handle("diagnose", async (req) => {
  const largeDoc = req.sql.length > 500 * 1024;
  const diagnostics = diagnose({ sql: req.sql, cursor: req.cursor, graph: activeGraph, largeDoc });
  return { diagnostics };
});
server.handle("resolve-hover", async (req) => {
  if (!activeGraph) return { documentation: null };
  const doc = resolveHoverDoc(req.symbol, activeGraph);
  return { documentation: doc };
});
server.handle("jsonb-tree", async (req) => {
  if (!activeGraph) return { paths: [] };
  const [schema] = req.relationKey.toLowerCase().split(".");
  const rel = activeGraph.schemas[schema ?? ""]?.relations[req.relationKey.toLowerCase()] ?? null;
  if (!rel) return { paths: [] };
  const col = rel.columns.find((c) => c.key === req.column.toLowerCase());
  if (!col) return { paths: [] };
  return { paths: col.jsonbPaths ?? [] };
});
server.handle("parse-ddl", async (req) => {
  server.emitProgress(req.id, { phase: "reading", processed: 0, total: req.raw.length });
  server.emitProgress(req.id, { phase: "tokenizing", processed: 0, total: 1 });
  const result = parseDdl(req.raw, req.snapshotId, req.displayName, req.sourceFileName);
  server.emitProgress(req.id, { phase: "indexing", processed: 0, total: 1 });
  void buildIndex(result.graph);
  server.emitProgress(req.id, { phase: "done", processed: 1, total: 1 });
  return { graph: result.graph, warnings: result.warnings };
});
server.handle("diff-snapshots", async (req) => {
  return diffSnapshots(req.a, req.b);
});
server.handle("detect-danger", async (req) => {
  return detectDanger(req.sql);
});
function resolveHoverDoc(symbol, graph) {
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".");
  if (parts.length === 3) {
    const [schema, table, col] = parts;
    const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`] ?? null;
    if (rel) {
      const column = rel.columns.find((c) => c.key === col.toLowerCase());
      if (column) return columnDoc(rel, column);
    }
  }
  if (parts.length === 2) {
    const [schema, table] = parts;
    const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`] ?? null;
    if (rel) return relationDoc(rel);
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        const c = r.columns.find((c2) => c2.key === parts[1].toLowerCase());
        if (c && r.name.toLowerCase() === parts[0].toLowerCase()) return columnDoc(r, c);
      }
    }
  }
  if (parts.length === 1) {
    const fn = graph.functions.find((f) => f.name.toLowerCase() === parts[0].toLowerCase());
    if (fn) {
      return {
        qualifiedName: `${fn.schema}.${fn.name}`,
        kind: "function",
        detail: `RETURNS ${fn.returnType} (${fn.args.map((a) => a.dataType).join(", ")})`,
        comment: fn.comment,
        dataType: fn.returnType
      };
    }
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        if (r.name.toLowerCase() === parts[0].toLowerCase()) return relationDoc(r);
      }
    }
  }
  return null;
}
function relationDoc(rel) {
  const lines = [];
  lines.push(`Kind: ${rel.kind}`);
  if (rel.columns.length) lines.push(`Columns: ${rel.columns.length}`);
  if (rel.primaryKey.length) lines.push(`PK: ${rel.primaryKey.join(", ")}`);
  if (rel.foreignKeys.length) lines.push(`FKs: ${rel.foreignKeys.length}`);
  if (rel.comment) lines.push(`Comment: ${rel.comment}`);
  return {
    qualifiedName: `${rel.schema}.${rel.name}`,
    kind: "relation",
    comment: rel.comment,
    primaryKey: rel.primaryKey,
    detail: lines.join("\n")
  };
}
function columnDoc(rel, col) {
  const lines = [];
  lines.push(`Type: ${col.dataType}`);
  lines.push(`Nullable: ${col.nullable ? "YES" : "NO"}`);
  if (col.defaultExpression) lines.push(`Default: ${col.defaultExpression}`);
  if (col.isPrimaryKey) lines.push("Primary key");
  if (col.foreignKey) {
    lines.push(`FK -> ${col.foreignKey.referencedSchema}.${col.foreignKey.referencedTable}(${col.foreignKey.referencedColumns.join(", ")})`);
  }
  if (col.comment) lines.push(`Comment: ${col.comment}`);
  if (col.jsonbPaths && col.jsonbPaths.length) lines.push(`JSONB root paths: ${countJsonbRoots(col.jsonbPaths)}`);
  return {
    qualifiedName: `${rel.schema}.${rel.name}.${col.name}`,
    kind: "column",
    dataType: col.dataType,
    nullable: col.nullable,
    defaultExpression: col.defaultExpression,
    comment: col.comment,
    foreignKey: col.foreignKey ? `${col.foreignKey.referencedSchema}.${col.foreignKey.referencedTable}(${col.foreignKey.referencedColumns.join(", ")})` : void 0,
    jsonbRootCount: col.jsonbPaths?.length,
    detail: lines.join("\n")
  };
}
function countJsonbRoots(paths) {
  return paths.length;
}
