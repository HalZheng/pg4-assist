// DDL parser for pg_dump --schema-only output (SPEC §5.3).
// Builds a SchemaGraph. Tolerant: unrecognized statements are collected as warnings,
// only consistency-fatal errors block snapshot creation.

import type {
  SchemaGraph,
  SchemaNode,
  TableNode,
  ColumnNode,
  ForeignKeyNode,
  IndexNode,
  FunctionNode,
  JsonbPathNode,
} from "../types/schema-graph";
import type { DdlParseResult, DdlWarning } from "../types/editor";
import type { Token } from "./sql-tokenizer";
import { tokenize, significantTokens, splitStatements } from "./sql-tokenizer";
import { normalizeType } from "./sql-reference";
import { relationKey, foldKey } from "../types/schema-graph";
import { extractJsonbAnnotations, buildJsonbTree } from "./jsonb-parser";

export const DDL_PARSER_VERSION = 1;

interface ParseContext {
  graph: SchemaGraph;
  warnings: DdlWarning[];
}

export function parseDdl(
  rawDdl: string,
  snapshotId: string,
  displayName: string,
  sourceFileName: string
): DdlParseResult {
  const graph: SchemaGraph = {
    snapshotId,
    displayName,
    sourceFileName,
    importedAt: new Date().toISOString(),
    parserVersion: DDL_PARSER_VERSION,
    schemas: {},
    functions: [],
  };
  const ctx: ParseContext = { graph, warnings: [] };

  // 1. Extract @pg4-jsonb annotations first (these attach to columns during/after parsing).
  const { annotations, warnings: annotWarnings } = extractJsonbAnnotations(rawDdl);
  ctx.warnings.push(...annotWarnings);

  // Group annotations by column for tree building.
  const annotationsByColumn = new Map<string, typeof annotations>();
  for (const a of annotations) {
    const k = `${a.schema.toLowerCase()}.${a.table.toLowerCase()}.${a.column.toLowerCase()}`;
    const arr = annotationsByColumn.get(k) ?? [];
    arr.push(a);
    annotationsByColumn.set(k, arr);
  }

  // 2. Tokenize and split into statements.
  const tokens = tokenize(rawDdl);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);

  for (const stmt of statements) {
    if (stmt.length === 0) continue;
    try {
      parseStatement(stmt, ctx);
    } catch (e: any) {
      ctx.warnings.push({
        line: stmt[0]?.line ?? 0,
        excerpt: tokensFor(stmt).slice(0, 120),
        code: "statement-error",
        message: e?.message ?? String(e),
      });
    }
  }

  // 3. Attach JSONB trees to columns.
  // Note: annotation keys are user-authored metadata in DDL comments and carry
  // no quoting context, so they are matched against lowercased (unquoted) keys.
  // JSONB annotations targeting double-quoted mixed-case tables are not supported.
  for (const [colKey, anns] of annotationsByColumn) {
    const [schema, table, column] = colKey.split(".");
    const rel = lookupRelation(ctx.graph, schema!, table!);
    if (!rel) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`,
      });
      continue;
    }
    const col = rel.columns.find((c) => c.key === column);
    if (!col) {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-missing",
        message: `@pg4-jsonb targets unknown column ${schema}.${table}.${column}`,
      });
      continue;
    }
    if (col.baseType !== "jsonb" && col.baseType !== "json") {
      ctx.warnings.push({
        line: 0,
        excerpt: `${schema}.${table}.${column}`,
        code: "jsonb-target-type",
        message: `@pg4-jsonb on non-JSON column ${col.dataType} ${schema}.${table}.${column}`,
      });
      // still allow attaching for user convenience
    }
    const { roots, warnings: treeWarnings } = buildJsonbTree(anns);
    col.jsonbPaths = roots;
    ctx.warnings.push(...treeWarnings);
  }

  return { graph, warnings: ctx.warnings };
}

function tokensFor(stmt: Token[]): string {
  return stmt.map((t) => t.text).join("");
}

// ---- statement dispatch ----

function parseStatement(stmt: Token[], ctx: ParseContext): void {
  const kw = upperAt(stmt, 0);
  if (kw === "CREATE") parseCreate(stmt, ctx);
  else if (kw === "ALTER") parseAlter(stmt, ctx);
  else if (kw === "COMMENT") parseComment(stmt, ctx);
  else if (kw === "SET" || kw === "SELECT" || kw === "INSERT" || kw === "UPDATE" || kw === "DELETE") {
    // session settings / pg_dump internals — ignore silently
  } else if (kw === "GRANT" || kw === "REVOKE") {
    // privileges — ignore
  } else {
    // unknown leading keyword — warn but continue
    ctx.warnings.push({
      line: stmt[0]?.line ?? 0,
      excerpt: tokensFor(stmt).slice(0, 120),
      code: "unsupported-statement",
      message: `unsupported statement starting with "${kw}"`,
    });
  }
}

function parseCreate(stmt: Token[], ctx: ParseContext): void {
  // CREATE [OR REPLACE] [UNLOGGED|TEMP|TEMPORARY] [UNIQUE] ... <object> ...
  let i = 1;
  i = skipOrReplace(stmt, i);
  // optional UNLOGGED / TEMP / TEMPORARY
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

function skipOrReplace(stmt: Token[], i: number): number {
  if (upperAt(stmt, i) === "OR" && upperAt(stmt, i + 1) === "REPLACE") return i + 2;
  return i;
}

function parseCreateSchema(stmt: Token[], start: number, ctx: ParseContext): void {
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

function parseCreateTable(stmt: Token[], start: number, ctx: ParseContext): void {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  // optional schema.name
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  i = end;
  // expect `(`
  const paren = stmt[i];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") {
    ctx.warnings.push(warn(stmt, "table-no-body", `CREATE TABLE ${relName} without column list`));
    return;
  }
  // find matching close paren
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) {
    ctx.warnings.push(warn(stmt, "unbalanced-parens", "unbalanced parentheses in CREATE TABLE"));
    return;
  }
  const innerTokens = stmt.slice(i + 1, closeIdx);
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const table: TableNode = {
    kind: "table",
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
  };
  schema.relations[table.key] = table;

  parseTableBody(innerTokens, table, ctx);
  // apply primary key flags from PK list (case-insensitive: PG folds unquoted
  // identifiers, but a table-level constraint may reference the column in a
  // different casing than the column definition — compare folded keys).
  for (const col of table.columns) {
    if (table.primaryKey.some((pk) => pk.toLowerCase() === col.key.toLowerCase())) col.isPrimaryKey = true;
  }
}

function parseCreateRelation(
  stmt: Token[],
  start: number,
  kind: "view" | "materialized-view" | "foreign-table",
  ctx: ParseContext
): void {
  let i = start;
  if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "NOT" && upperAt(stmt, i + 2) === "EXISTS") i += 3;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const schema = ensureSchema(ctx.graph, schemaName, schemaQuoted);
  const rel: TableNode = {
    kind,
    schema: schema.name,
    name: relName,
    key: relationKey(schema.name, relName, schema.quoted, relQuoted),
    quoted: relQuoted,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
  };
  schema.relations[rel.key] = rel;
  // For views we don't reliably parse columns; leave empty (completion can still offer the relation).
  // If it's a foreign table with a column list, parse it like a table.
  if (kind === "foreign-table") {
    const paren = stmt[end];
    if (paren && paren.type === "punctuation" && paren.text === "(") {
      const closeIdx = findMatchingParen(stmt, end);
      if (closeIdx > 0) parseTableBody(stmt.slice(end + 1, closeIdx), rel, ctx);
    }
  }
}

function parseTableBody(inner: Token[], table: TableNode, ctx: ParseContext): void {
  // split by top-level commas
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
      // skip check constraints (not modeled)
    } else if (leadingKw === "EXCLUDE") {
      // skip
    } else {
      parseColumnDef(item, table, ctx);
    }
  }
}

function parseColumnDef(item: Token[], table: TableNode, ctx: ParseContext): void {
  const nameTok = item[0];
  if (!nameTok || (nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier")) {
    ctx.warnings.push(warn(item, "column-name", "expected column name"));
    return;
  }
  const quoted = nameTok.type === "quoted-identifier";
  const name = nameTok.value ?? nameTok.text;
  // type token(s): from index 1 until a known column-level keyword / constraint keyword.
  const typeEnd = findColumnOptionStart(item, 1);
  const typeTokens = item.slice(1, typeEnd);
  if (typeTokens.length === 0) {
    ctx.warnings.push(warn(item, "column-type", `column ${name} has no type`));
    return;
  }
  const dataType = typeTokens.map((t) => t.text).join("").trim();
  const { baseType, isArray } = normalizeType(dataType);

  const col: ColumnNode = {
    name,
    key: foldKey(name, quoted),
    quoted,
    dataType,
    baseType: isArray ? `${baseType}[]` : baseType,
    nullable: true,
    ordinal: table.columns.length + 1,
    isPrimaryKey: false,
  };

  // scan options after type
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
        col.defaultExpression = tokensFor(item.slice(i + 1)).trim() || undefined;
        i = item.length; // consume rest
        break;
      case "PRIMARY":
        if (upperAt(item, i + 1) === "KEY") {
          col.isPrimaryKey = true;
          if (!table.primaryKey.includes(name)) table.primaryKey.push(name);
          i++;
        }
        break;
      case "UNIQUE":
        // inline unique — not modeled per-column but ok
        break;
      case "REFERENCES":
      case "FOREIGN": {
        // REFERENCES schema.table (cols) [ON DELETE/UPDATE ...]
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
        // GENERATED ... AS IDENTITY / ALWAYS / BY DEFAULT — treat as NOT NULL identity
        // skip until next recognizable option
        break;
      case "CHECK":
        // skip until end (check expr)
        i = item.length;
        break;
      case "COLLATE":
        i++; // skip collation name token
        break;
    }
  }
  table.columns.push(col);
}

interface MutableForeignKey extends ForeignKeyNode {
  _endIndex?: number;
}

function parseReferences(item: Token[], start: number, table: TableNode, ctx: ParseContext): MutableForeignKey | null {
  const { schemaName, relName, end } = readQualifiedName(item, start, ctx);
  if (!relName) return null;
  let i = end;
  // optional ( col, col )
  let cols: string[] = [];
  const openTok = item[i];
  if (openTok && openTok.type === "punctuation" && openTok.text === "(") {
    const closeIdx = findMatchingParen(item, i);
    if (closeIdx > 0) {
      cols = splitTopLevelCommas(item.slice(i + 1, closeIdx))
        .map((p) => p.map((t) => t.text).join(""))
        .map((s) => s.trim())
        .filter(Boolean);
      i = closeIdx + 1;
    }
  }
  // skip ON DELETE / ON UPDATE / MATCH / DEFERRABLE ... until comma or end
  while (i < item.length) {
    const kw = upperAt(item, i);
    if (kw === "ON" || kw === "MATCH" || kw === "DEFERRABLE" || kw === "INITIALLY" || kw === "NOT") {
      i++;
    } else {
      break;
    }
  }
  const fk: MutableForeignKey = {
    name: undefined,
    localColumns: [],
    referencedSchema: schemaName,
    referencedTable: relName,
    referencedColumns: cols,
    _endIndex: i - 1,
  };
  return fk;
}

function parseTableConstraint(stmt: Token[], start: number, table: TableNode, ctx: ParseContext): void {
  // CONSTRAINT name <type>
  const nameTok = stmt[start];
  let i = start + 1;
  const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : undefined;
  const kw = upperAt(stmt, i);
  if (kw === "PRIMARY" && upperAt(stmt, i + 1) === "KEY") {
    parsePrimaryKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "UNIQUE") {
    parseUniqueConstraint(stmt, i + 1, table, ctx, constraintName);
  } else if (kw === "FOREIGN" && upperAt(stmt, i + 1) === "KEY") {
    parseForeignKeyConstraint(stmt, i + 2, table, ctx, constraintName);
  } else if (kw === "CHECK" || kw === "EXCLUDE") {
    // not modeled
  }
}

function parsePrimaryKeyConstraint(stmt: Token[], start: number, table: TableNode, ctx: ParseContext, name?: string): void {
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.primaryKey = Array.from(new Set([...table.primaryKey, ...cols]));
}

function parseUniqueConstraint(stmt: Token[], start: number, table: TableNode, ctx: ParseContext, name?: string): void {
  // we only record columns into a synthetic index for ranking/hover
  const cols = readParenColumns(stmt, start);
  if (cols.length === 0) return;
  table.indexes.push({
    name: name ?? `__unique_${table.indexes.length}`,
    columns: cols,
    unique: true,
  });
}

function parseForeignKeyConstraint(stmt: Token[], start: number, table: TableNode, ctx: ParseContext, name?: string): void {
  // FOREIGN KEY (local_cols) REFERENCES ref(cols)
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
    referencedColumns: refCols,
  });
  // also annotate columns
  for (const lc of localCols) {
    const col = table.columns.find((c) => c.key === lc.toLowerCase());
    if (col && !col.foreignKey) {
      col.foreignKey = {
        name,
        localColumns: localCols,
        referencedSchema: schemaName,
        referencedTable: relName,
        referencedColumns: refCols,
      };
    }
  }
}

function readParenColumns(stmt: Token[], start: number): string[] {
  const paren = stmt[start];
  if (!paren || paren.type !== "punctuation" || paren.text !== "(") return [];
  const closeIdx = findMatchingParen(stmt, start);
  if (closeIdx < 0) return [];
  const inner = stmt.slice(start + 1, closeIdx);
  return splitTopLevelCommas(inner)
    .map((p) => p.map((t) => t.text).join("").trim())
    .map((s) => s.replace(/["']/g, ""))
    .filter(Boolean);
}

function skipParen(stmt: Token[], start: number): number {
  if (stmt[start]?.text === "(") {
    const closeIdx = findMatchingParen(stmt, start);
    return closeIdx < 0 ? start + 1 : closeIdx + 1;
  }
  return start;
}

function findColumnOptionStart(item: Token[], from: number): number {
  const stopKws = new Set([
    "NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "REFERENCES", "FOREIGN",
    "CHECK", "GENERATED", "COLLATE", "CONSTRAINT",
  ]);
  let depth = 0;
  for (let i = from; i < item.length; i++) {
    const t = item[i]!;
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth--;
    if (depth === 0 && t.type === "keyword" && stopKws.has(t.text.toUpperCase())) {
      return i;
    }
  }
  return item.length;
}

function parseCreateIndex(stmt: Token[], start: number, ctx: ParseContext): void {
  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [schema.]table (cols)
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
  // optional index name
  const nameTok = stmt[i];
  if (nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier")) {
    i++;
  }
  if (upperAt(stmt, i) === "ON") i++;
  const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!relName) return;
  const rel = lookupRelation(ctx.graph, schemaName, relName, schemaQuoted, relQuoted);
  if (!rel) {
    ctx.warnings.push(warn(stmt, "index-target-missing", `CREATE INDEX on unknown table ${schemaName}.${relName}`));
    return;
  }
  const cols = readParenColumns(stmt, end);
  const isPartial = stmt.slice(end).some((t) => t.type === "keyword" && t.text.toUpperCase() === "WHERE");
  // find index name: walk back to find the identifier before ON
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

function parseCreateFunction(stmt: Token[], start: number, ctx: ParseContext): void {
  let i = start;
  i = skipOrReplace(stmt, i);
  // function name
  const { schemaName, relName: fnName, schemaQuoted, relQuoted: fnQuoted, end } = readQualifiedName(stmt, i, ctx);
  if (!fnName) return;
  i = end;
  // args in parens
  const argsOpenTok = stmt[i];
  if (!argsOpenTok || argsOpenTok.text !== "(") return;
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) return;
  const argsTokens = stmt.slice(i + 1, closeIdx);
  const args = parseFunctionArgs(argsTokens);
  i = closeIdx + 1;
  // RETURNS type [TABLE] | SETOF
  let returnType = "void";
  if (upperAt(stmt, i) === "RETURNS") {
    i++;
    if (upperAt(stmt, i) === "SETOF") i++;
    // type until LANGUAGE / AS / WINDOW / etc.
    const typeTokens: Token[] = [];
    while (i < stmt.length) {
      const kw = upperAt(stmt, i);
      if (kw === "LANGUAGE" || kw === "AS" || kw === "WINDOW" || kw === "STRICT" || kw === "VOLATILE" || kw === "STABLE" || kw === "IMMUTABLE" || kw === "SECURITY" || kw === "PARALLEL" || kw === "COST" || kw === "ROWS") break;
      typeTokens.push(stmt[i]!);
      i++;
    }
    returnType = typeTokens.map((t) => t.text).join("").trim() || returnType;
  }
  let language: string | undefined;
  while (i < stmt.length) {
    if (upperAt(stmt, i) === "LANGUAGE") {
      language = stmt[i + 1]?.text;
      i += 2;
    } else i++;
  }
  const fn: FunctionNode = {
    schema: schemaName,
    name: fnName,
    key: `${schemaName.toLowerCase()}.${fnName.toLowerCase()}`,
    args,
    returnType,
    language,
    quoted: fnQuoted,
  };
  ctx.graph.functions.push(fn);
}

function parseFunctionArgs(tokens: Token[]): FunctionNode["args"] {
  const args: FunctionNode["args"] = [];
  if (tokens.length === 0) return args;
  const parts = splitTopLevelCommas(tokens);
  for (const part of parts) {
    if (part.length === 0) continue;
    let mode: "in" | "out" | "inout" | "variadic" = "in";
    let j = 0;
    const first = upperAt(part, 0);
    if (first === "IN") { mode = "in"; j = 1; }
    else if (first === "OUT") { mode = "out"; j = 1; }
    else if (first === "INOUT") { mode = "inout"; j = 1; }
    else if (first === "VARIADIC") { mode = "variadic"; j = 1; }
    // arg could be "name type" or just "type"
    let name: string | undefined;
    let dataType: string;
    const nameTok = part[j];
    const typeTok = part[j + 1];
    // Heuristic: if two identifier-ish tokens, first is name; else single token is type.
    if (nameTok && typeTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") && typeTok.type !== "punctuation") {
      name = nameTok.value ?? nameTok.text;
      dataType = part.slice(j + 1).map((t) => t.text).join("").trim();
    } else {
      dataType = part.slice(j).map((t) => t.text).join("").trim();
    }
    // default value DEFAULT expr
    let defaultVal: string | undefined;
    const defIdx = part.findIndex((t) => t.type === "keyword" && t.text.toUpperCase() === "DEFAULT");
    if (defIdx >= 0) {
      defaultVal = part.slice(defIdx + 1).map((t) => t.text).join("").trim() || undefined;
      dataType = part.slice(j, defIdx).filter((t) => !(t.type === "keyword" && t.text.toUpperCase() === "DEFAULT")).map((t) => t.text).join("").trim();
    }
    if (!dataType) continue;
    args.push({ name, dataType, mode, default: defaultVal });
  }
  return args;
}

function parseAlter(stmt: Token[], ctx: ParseContext): void {
  // ALTER TABLE [schema.]name ADD CONSTRAINT ...
  const obj = upperAt(stmt, 1);
  if (obj === "TABLE") {
    let i = 2;
    if (upperAt(stmt, i) === "IF" && upperAt(stmt, i + 1) === "EXISTS") i += 2;
    const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName, schemaQuoted, relQuoted);
    i = end;
    const action = upperAt(stmt, i);
    if (action === "ADD") {
      let j = i + 1;
      if (upperAt(stmt, j) === "CONSTRAINT") {
        // CONSTRAINT name <type>
        const nameTok = stmt[j + 1];
        const constraintName = nameTok && (nameTok.type === "identifier" || nameTok.type === "quoted-identifier") ? nameTok.value ?? nameTok.text : undefined;
        const typeKw = upperAt(stmt, j + 2);
        if (typeKw === "PRIMARY" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parsePrimaryKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        } else if (typeKw === "UNIQUE") {
          if (rel) parseUniqueConstraint(stmt, j + 3, rel, ctx, constraintName);
        } else if (typeKw === "FOREIGN" && upperAt(stmt, j + 3) === "KEY") {
          if (rel) parseForeignKeyConstraint(stmt, j + 4, rel, ctx, constraintName);
        }
        // CHECK/EXCLUDE ignored
      } else {
        // ADD PRIMARY KEY (...) / ADD UNIQUE (...)
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
      // ALTER COLUMN x SET DEFAULT / DROP NOT NULL / SET NOT NULL / TYPE ...
      const colTok = stmt[i + 2];
      if (!colTok || !rel) return;
      const colName = (colTok.value ?? colTok.text).toLowerCase();
      const col = rel.columns.find((c) => c.key === colName);
      if (!col) return;
      const op = upperAt(stmt, i + 3);
      if (op === "SET" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = stmt.slice(i + 5).map((t) => t.text).join("").trim() || undefined;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "DEFAULT") {
        col.defaultExpression = undefined;
      } else if (op === "SET" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = false;
      } else if (op === "DROP" && upperAt(stmt, i + 4) === "NOT" && upperAt(stmt, i + 5) === "NULL") {
        col.nullable = true;
      } else if (op === "TYPE" || (op === "SET" && upperAt(stmt, i + 4) === "DATA" && upperAt(stmt, i + 5) === "TYPE")) {
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
  // ALTER SCHEMA / ALTER FUNCTION ... ignored
}

function parseComment(stmt: Token[], ctx: ParseContext): void {
  // COMMENT ON TABLE [schema.]name IS 'text'
  // COMMENT ON COLUMN [schema.]table.col IS 'text'
  const obj = upperAt(stmt, 2);
  let i = 3;
  if (obj === "TABLE") {
    const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName, schemaQuoted, relQuoted);
    if (rel) {
      const comment = readStringLiteral(stmt, end);
      if (comment != null) rel.comment = comment;
    }
  } else if (obj === "COLUMN") {
    // schema.table.column  — but column could be schema.table (3-part). Read qualified then expect .col
    const { schemaName, relName, schemaQuoted, relQuoted, end } = readQualifiedName(stmt, i, ctx);
    if (!relName) return;
    // expect . col
    let j = end;
    let colName: string | undefined;
    const dotTok = stmt[j];
    const colTok = stmt[j + 1];
    if (dotTok && dotTok.text === "." && colTok) {
      // Respect quoted-identifier folding for the column name (SPEC §5.2).
      const colQuoted = colTok.type === "quoted-identifier";
      colName = foldKey(colTok.value ?? colTok.text, colQuoted);
      j += 2;
    }
    if (!colName) return;
    const rel = lookupRelation(ctx.graph, schemaName, relName, schemaQuoted, relQuoted);
    if (rel) {
      const col = rel.columns.find((c) => c.key === colName);
      if (col) {
        const comment = readStringLiteral(stmt, j);
        if (comment != null) col.comment = comment;
      }
    }
  }
  // COMMENT ON FUNCTION / SCHEMA ignored for now
}

function readStringLiteral(stmt: Token[], from: number): string | null {
  for (let i = from; i < stmt.length; i++) {
    if (stmt[i]!.type === "string") return (stmt[i]!.value ?? "") || "";
  }
  return null;
}

// ---- helpers ----

function readQualifiedName(
  stmt: Token[],
  from: number,
  ctx: ParseContext
): { schemaName: string; relName: string; schemaQuoted: boolean; relQuoted: boolean; end: number } {
  // default schema = public (Postgres default search_path often public)
  let schemaName = "public";
  let schemaQuoted = false;
  let relName = "";
  let relQuoted = false;
  let i = from;
  const first = stmt[i];
  if (!first || (first.type !== "identifier" && first.type !== "quoted-identifier")) {
    return { schemaName, relName, schemaQuoted, relQuoted, end: from };
  }
  const firstName = first.value ?? first.text;
  const firstQuoted = first.type === "quoted-identifier";
  // check for schema.name
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

function ensureSchema(graph: SchemaGraph, name: string, quoted: boolean): SchemaNode {
  const key = foldKey(name, quoted);
  let s = graph.schemas[key];
  if (!s) {
    s = { name, key, quoted, relations: {} };
    graph.schemas[key] = s;
  }
  return s;
}

function lookupRelation(
  graph: SchemaGraph,
  schemaName: string,
  relName: string,
  schemaQuoted = false,
  relQuoted = false
): TableNode | null {
  // Respect PostgreSQL identifier folding (SPEC §5.2): unquoted identifiers
  // fold to lowercase, double-quoted identifiers keep their exact case.
  // Mirrors `getRelation` in schema-index.ts so DDL-internal lookups (FK,
  // ALTER TABLE, CREATE INDEX, COMMENT) stay consistent with storage keys.
  const sk = foldKey(schemaName, schemaQuoted);
  const rk = `${sk}.${foldKey(relName, relQuoted)}`;
  return graph.schemas[sk]?.relations[rk] ?? null;
}

function splitTopLevelCommas(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
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

function findMatchingParen(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function upperAt(stmt: Token[], i: number): string {
  if (i < 0 || i >= stmt.length) return "";
  return stmt[i]!.text.toUpperCase();
}

function warn(stmt: Token[], code: string, message: string): DdlWarning {
  return {
    line: stmt[0]?.line ?? 0,
    excerpt: tokensFor(stmt).slice(0, 120),
    code,
    message,
  };
}

function unsupported(stmt: Token[], ctx: ParseContext, obj: string): void {
  ctx.warnings.push(warn(stmt, "unsupported-create", `unsupported CREATE ${obj}`));
}
