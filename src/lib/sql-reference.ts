// PostgreSQL keyword set and builtin function reference for completion fallback & ranking.

export const SQL_KEYWORDS: ReadonlyArray<{ label: string; insertText?: string }> = [
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
  { label: "ROWS ONLY", insertText: "ROWS ONLY" },
];

export interface BuiltinFunction {
  name: string;
  returnType: string;
  argsDescription: string;
  detail: string;
}

export const BUILTIN_FUNCTIONS: ReadonlyArray<BuiltinFunction> = [
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
  { name: "exists", returnType: "bool", argsDescription: "(subquery)", detail: "Subquery existence" },
];

/** Normalize a PostgreSQL type token to a base type for matching/diagnostics. */
export function normalizeType(type: string): { baseType: string; isArray: boolean; original: string } {
  const trimmed = type.trim().toLowerCase();
  // array suffix [] or ARRAY
  const arrMatch = trimmed.match(/^(.+?)\s*(?:\[\s*\])+$/);
  let core = trimmed;
  let isArray = false;
  if (arrMatch) {
    core = arrMatch[1]!.trim();
    isArray = true;
  }
  // strip type modifiers like varchar(50), numeric(10,2), timestamp(6)
  core = core.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // with/without time zone normalization
  core = core.replace(/\s+with(out)?\s+time\s+zone$/, "").trim();
  // alias mapping
  const alias: Record<string, string> = {
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
    json: "jsonb",
  };
  return { baseType: alias[core] ?? core, isArray, original: type };
}

/** PostgreSQL implicit cast compatibility for diagnostics type-mismatch heuristic. */
export function typesComparable(a: string, b: string): boolean {
  const ba = normalizeType(a).baseType;
  const bb = normalizeType(b).baseType;
  if (ba === bb) return true;
  // numeric family
  const numeric = new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);
  if (numeric.has(ba) && numeric.has(bb)) return true;
  // text family
  const text = new Set(["text", "varchar", "bpchar", "name"]);
  if (text.has(ba) && text.has(bb)) return true;
  // timestamp family
  const ts = new Set(["timestamptz", "timestamp", "date", "time"]);
  if (ts.has(ba) && ts.has(bb)) return true;
  // json family
  const json = new Set(["json", "jsonb"]);
  if (json.has(ba) && json.has(bb)) return true;
  return false;
}

export function isTextLikeType(baseType: string): boolean {
  return new Set(["text", "varchar", "bpchar", "name", "char"]).has(baseType);
}

export function isNumericType(baseType: string): boolean {
  return new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision", "money"]).has(baseType);
}
