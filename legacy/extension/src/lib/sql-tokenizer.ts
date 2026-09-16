// SQL tokenizer (SPEC §6.1). Tolerant: never throws on incomplete input.
// Handles comments (-- and /* */), single-quoted strings with '' escapes,
// double-quoted identifiers, dollar-quoted bodies ($tag$ ... $tag$), numbers,
// identifiers/keywords, operators and JSONB path operators (->, ->>, #>, #>>).

export type TokenType =
  | "identifier"
  | "quoted-identifier"
  | "keyword"
  | "string"
  | "number"
  | "operator"
  | "punctuation"
  | "comment-line"
  | "comment-block"
  | "dollar-quote"
  | "whitespace"
  | "newline"
  | "eof";

export interface Token {
  type: TokenType;
  /** raw text */
  text: string;
  /** start offset in source */
  start: number;
  /** end offset (exclusive) */
  end: number;
  /** line number (1-based) */
  line: number;
  /** for identifiers/strings: the decoded value (lowercased-normalized handled separately) */
  value?: string;
}

const KEYWORD_CHAR_RE = /[A-Za-z0-9_]/;
const IDENT_START_RE = /[A-Za-z_]/;
const DIGIT_RE = /[0-9]/;
const WHITESPACE_RE = /\s/;
const PUNCTUATION = new Set(["(", ")", ",", ";", ".", "[", "]", ":", "*"]);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = sql.length;

  const push = (t: Token) => tokens.push(t);

  while (i < n) {
    const ch = sql[i]!;

    if (ch === "\n") {
      push({ type: "newline", text: "\n", start: i, end: i + 1, line });
      line++;
      i++;
      continue;
    }
    if (WHITESPACE_RE.test(ch)) {
      let j = i + 1;
      while (j < n && WHITESPACE_RE.test(sql[j]!) && sql[j] !== "\n") j++;
      push({ type: "whitespace", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }

    // line comment
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push({ type: "comment-line", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }

    // block comment (nested supported)
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

    // single-quoted string
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

    // double-quoted identifier
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
      const closed = text.endsWith('"');
      const value = text.slice(1, closed ? -1 : undefined).replace(/""/g, '"');
      push({ type: "quoted-identifier", text, start: i, end: j, line, value });
      i = j;
      continue;
    }

    // dollar quote: $tag$ ... $tag$
    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const j = closeIdx < 0 ? n : closeIdx + tag.length;
        // count newlines inside
        for (let k = i; k < j; k++) if (sql[k] === "\n") line++;
        push({ type: "dollar-quote", text: sql.slice(i, j), start: i, end: j, line, value: tag });
        i = j;
        continue;
      }
    }

    // number
    if (DIGIT_RE.test(ch) || (ch === "." && DIGIT_RE.test(sql[i + 1] ?? ""))) {
      let j = i;
      // consume digits, dots, exponent, hex
      if (ch === "0" && (sql[i + 1] === "x" || sql[i + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(sql[j]!)) j++;
      } else {
        while (j < n && (DIGIT_RE.test(sql[j]!) || sql[j] === ".")) j++;
        if (sql[j] === "e" || sql[j] === "E") {
          j++;
          if (sql[j] === "+" || sql[j] === "-") j++;
          while (j < n && DIGIT_RE.test(sql[j]!)) j++;
        }
      }
      push({ type: "number", text: sql.slice(i, j), start: i, end: j, line });
      i = j;
      continue;
    }

    // identifier / keyword
    if (IDENT_START_RE.test(ch)) {
      let j = i + 1;
      while (j < n && KEYWORD_CHAR_RE.test(sql[j]!)) j++;
      const text = sql.slice(i, j);
      const upper = text.toUpperCase();
      const isKeyword = KEYWORDS.has(upper);
      push({
        type: isKeyword ? "keyword" : "identifier",
        text,
        start: i,
        end: j,
        line,
        value: text,
      });
      i = j;
      continue;
    }

    // JSONB operators
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

    // multi-char operators
    if ("<>!=".includes(ch)) {
      let len = 1;
      if (sql[i + 1] === "=") len = 2;
      if ((ch === "<" && sql[i + 1] === ">") || (ch === "!" && sql[i + 1] === "=")) len = 2;
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

    // punctuation
    if (PUNCTUATION.has(ch)) {
      push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }

    // any other single char: treat as operator (e.g. + - * / % < > = ~)
    if ("+-*/%<>=~&|^@?".includes(ch)) {
      push({ type: "operator", text: ch, start: i, end: i + 1, line });
      i++;
      continue;
    }

    // unknown char: skip as punctuation to remain tolerant
    push({ type: "punctuation", text: ch, start: i, end: i + 1, line });
    i++;
  }

  push({ type: "eof", text: "", start: n, end: n, line });
  return tokens;
}

/** Tokens with whitespace/newlines/comments stripped (but keep positions). */
export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter(
    (t) =>
      t.type !== "whitespace" &&
      t.type !== "newline" &&
      t.type !== "comment-line" &&
      t.type !== "comment-block"
  );
}

/** Split tokens into statements at top-level semicolons (respecting parentheses & dollar quotes). */
export function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
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

export const KEYWORDS = new Set<string>([
  // Reserved
  "ALL", "ANALYSE", "ANALYZE", "AND", "ANY", "ARRAY", "AS", "ASC", "ASYMMETRIC", "AUTHORIZATION",
  "BINARY", "BOTH", "CASE", "CAST", "CHECK", "COLLATE", "COLLATION", "COLUMN", "CONCURRENTLY", "CONSTRAINT",
  "CREATE", "CROSS", "CURRENT_CATALOG", "CURRENT_DATE", "CURRENT_ROLE", "CURRENT_SCHEMA", "CURRENT_TIME",
  "CURRENT_TIMESTAMP", "CURRENT_USER", "DEFAULT", "DEFERRABLE", "DESC", "DISTINCT", "DO", "ELSE", "END",
  "EXCEPT", "FALSE", "FETCH", "FOR", "FOREIGN", "FREEZE", "FROM", "FULL", "GRANT", "GROUP", "HAVING",
  "ILIKE", "IN", "INITIALLY", "INNER", "INTERSECT", "INTO", "IS", "ISNULL", "JOIN", "LATERAL", "LEADING",
  "LEFT", "LIKE", "LIMIT", "LOCALTIME", "LOCALTIMESTAMP", "NATURAL", "NOT", "NOTNULL", "NULL", "OFFSET",
  "ON", "ONLY", "OR", "ORDER", "OUTER", "OVERLAPS", "PLACING", "PRIMARY", "REFERENCES", "RETURNING",
  "RIGHT", "SELECT", "SESSION_USER", "SIMILAR", "SOME", "SYMMETRIC", "TABLE", "TABLESAMPLE", "THEN", "TO",
  "TRAILING", "TRUE", "UNION", "UNIQUE", "USER", "USING", "VARIADIC", "VERBOSE", "WHEN", "WHERE", "WINDOW", "WITH",
  // Non-reserved but commonly used
  "ABORT", "ABSOLUTE", "ACCESS", "ACTION", "ADD", "ADMIN", "AFTER", "AGGREGATE", "ALSO", "ALTER", "ALWAYS",
  "ASSERTION", "ASSIGNMENT", "AT", "ATTACH", "ATTRIBUTE", "BACKWARD", "BEFORE", "BEGIN", "BY", "CACHE", "CALL",
  "CALLED", "CASCADE", "CASCADED", "CATALOG", "CHAIN", "CHARACTERISTICS", "CHECKPOINT", "CLASS", "CLOSE", "CLUSTER",
  "COLUMNS", "COMMENT", "COMMENTS", "COMMIT", "COMMITTED", "COMPRESSION", "CONFIGURATION", "CONFLICT", "CONNECTION",
  "CONSTRAINTS", "CONTENT", "CONTINUE", "CONVERSION", "COPY", "COST", "CSV", "CUBE", "CURRENT", "CURSOR", "CYCLE",
  "DATA", "DATABASE", "DAY", "DAYS", "DEALLOCATE", "DECLARE", "DEFAULTS", "DEFERRED", "DEFINER", "DELETE",
  "DELIMITER", "DELIMITERS", "DEPENDS", "DETACH", "DICTIONARY", "DISABLE", "DISCARD", "DOCUMENT", "DOMAIN",
  "DOUBLE", "DROP", "EACH", "ENABLE", "ENCODING", "ENCRYPTED", "ENUM", "ESCAPE", "EVENT", "EXCLUDE", "EXCLUDING",
  "EXCLUSIVE", "EXECUTE", "EXISTS", "EXPLAIN", "EXPRESSION", "EXTENSION", "EXTERNAL", "FAMILY", "FILTER", "FIRST",
  "FOLLOWING", "FORCE", "FORWARD", "FUNCTION", "FUNCTIONS", "GLOBAL", "GRANTED", "HANDLER", "HEADER", "HOLD",
  "HOUR", "HOURS", "IDENTITY", "IF", "IMMEDIATE", "IMMUTABLE", "IMPLICIT", "IMPORT", "INCLUDE", "INCLUDING",
  "INCREMENT", "INDEX", "INDEXES", "INHERIT", "INHERITS", "INLINE", "INPUT", "INSENSITIVE", "INSERT", "INSTEAD",
  "INVOKER", "ISOLATION", "JSON", "JSONB", "KEY", "LABEL", "LANGUAGE", "LARGE", "LAST", "LEAKPROOF", "LEVEL", "LISTEN",
  "LOAD", "LOCAL", "LOCATION", "LOCK", "LOCKED", "LOGGED", "MAPPING", "MATCH", "MATCHED", "MATERIALIZED", "MAXVALUE",
  "METHOD", "MINUTE", "MINUTES", "MINVALUE", "MODE", "MONTH", "MONTHS", "MOVE", "NAME", "NAMES", "NEW", "NEXT", "NO",
  "NOTHING", "NOTIFY", "NOWAIT", "NULLS", "OBJECT", "OF", "OFF", "OIDS", "OLD", "OPERATOR", "OPTION", "OPTIONS", "OVER",
  "OVERRIDING", "OWNED", "OWNER", "PARALLEL", "PARSER", "PARTIAL", "PARTITION", "PASSING", "PASSWORD", "PERSISTENT",
  "PLANS", "POLICY", "PRECEDING", "PRECISION", "PREPARE", "PREPARED", "PRESERVE", "PRIOR", "PRIVILEGES", "PROCEDURAL",
  "PROCEDURE", "PROCEDURES", "PROGRAM", "PUBLICATION", "QUOTE", "RANGE", "READ", "REAL", "REASSIGN", "RECHECK",
  "RECURSIVE", "REF", "REFERENCING", "REFRESH", "REINDEX", "RELATIVE", "RELEASE", "RENAME", "REPEATABLE", "REPLACE",
  "REPLICA", "RESET", "RESTART", "RESTRICT", "RETURN", "REVOKE", "ROLE", "ROLLBACK", "ROLLUP", "ROUTINE", "ROUTINES",
  "ROW", "ROWS", "RULE", "SAVEPOINT", "SCHEMA", "SCHEMAS", "SCROLL", "SEARCH", "SECOND", "SECONDS", "SECRET",
  "SECURITY", "SEQUENCE", "SEQUENCES", "SERIALIZABLE", "SERVER", "SESSION", "SET", "SETS", "SHARE", "SHOW", "SIMPLE",
  "SKIP", "SNAPSHOT", "SQL", "STABLE", "STANDALONE", "START", "STATEMENT", "STATISTICS", "STDIN", "STDOUT", "STORAGE",
  "STORED", "STRICT", "STRIP", "SUBSCRIPTION", "SYSID", "SYSTEM", "TABLES", "TABLESPACE", "TEMP", "TEMPLATE",
  "TEMPORARY", "TEXT", "TRANSACTION", "TRANSFORM", "TRIGGER", "TRUNCATE", "TRUSTED", "TYPE", "TYPES", "UNBOUNDED",
  "UNCOMMITTED", "UNENCRYPTED", "UNKNOWN", "UNLISTEN", "UNLOGGED", "UNTIL", "UPDATE", "VACUUM", "VALID", "VALIDATE",
  "VALIDATOR", "VALUE", "VARIABLE", "VARYING", "VERSION", "VIEW", "VIEWS", "VIRTUAL", "VOLATILE", "WHITESPACE",
  "WITHIN", "WITHOUT", "WORK", "WRAPPER", "WRITE", "XML", "YEAR", "YEARS", "YES", "ZONE",
]);
