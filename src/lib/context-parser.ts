// SQL context parser (SPEC §6.1–6.4). Tolerant: never throws; degrades conservatively.
// Parses the statement containing the cursor and derives a CompletionContext.

import type { CompletionContext, CompletionContextKind, RelationRef, ColumnRef } from "../types/completion";
import type { SchemaGraph } from "../types/schema-graph";
import type { Token } from "./sql-tokenizer";
import { tokenize, significantTokens, splitStatements, KEYWORDS } from "./sql-tokenizer";
import { getRelation, lookupSchemas } from "./schema-index";

export interface ParsedContextInput {
  sql: string;
  cursor: number;
  graph: SchemaGraph | null;
}

/**
 * Build a CompletionContext at the given cursor position.
 * Returns an "unknown" context if parsing fails or cursor is outside any statement.
 */
export function buildCompletionContext(input: ParsedContextInput): CompletionContext {
  const { sql, cursor } = input;
  if (cursor < 0 || cursor > sql.length) {
    return unknownContext(0, 0, "");
  }
  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  // find statement containing the cursor
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
    jsonb: relationMap.jsonb,
  };
}

// ---- statement locating ----

interface LocatedStatement {
  tokens: Token[];
  /** absolute start offset of the statement in source */
  start: number;
}

function findStatementAtCursor(
  allTokens: Token[],
  cursor: number,
  statements: Token[][],
  sig: Token[]
): LocatedStatement | null {
  // Map significant tokens back to their position in the flat array.
  // find the significant token under or just before the cursor.
  // Build a list of statement spans using sig positions.
  if (sig.length === 0) return null;
  // Map sig tokens to statements by replaying splitStatements order.
  // Simpler: re-run split with index tracking.
  let idx = 0;
  const stmtSpans: { start: number; end: number; tokens: Token[] }[] = [];
  let cur: Token[] = [];
  let depth = 0;
  let stmtStart = sig[0]!.start;
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
  if (cur.length) stmtSpans.push({ start: stmtStart, end: sig[sig.length - 1]?.start ?? cur[cur.length - 1]!.end, tokens: cur });

  for (const span of stmtSpans) {
    if (cursor >= span.start && cursor <= span.end + 1) {
      return { tokens: span.tokens, start: span.start };
    }
  }
  // cursor may be after last statement's last token; return last statement.
  const last = stmtSpans[stmtSpans.length - 1];
  if (last) return { tokens: last.tokens, start: last.start };
  return null;
}

// ---- relation map ----

interface RelationMap {
  visibleRelations: RelationRef[];
  activeAlias?: string;
  activeRelation?: RelationRef;
  expectedTypes?: string[];
  jsonb?: CompletionContext["jsonb"];
}

function buildRelationMap(stmt: Token[], graph: SchemaGraph | null): RelationMap {
  const map: RelationMap = { visibleRelations: [] };
  // Walk through FROM/JOIN/UPDATE/INTO clauses to collect relations + aliases + CTEs.
  // CTEs defined by WITH name AS (...)
  collectCtesAndRelations(stmt, graph, map);
  return map;
}

function collectCtesAndRelations(stmt: Token[], graph: SchemaGraph | null, map: RelationMap): void {
  // First pass: collect CTE definitions (WITH name AS (...)) so they're available in FROM.
  const cteColumns = new Map<string, ColumnRef[]>();
  // find WITH ... at statement start
  let i = 0;
  if (upperAt(stmt, 0) === "WITH") {
    i = 1;
    // optional RECURSIVE
    if (upperAt(stmt, i) === "RECURSIVE") i++;
    // parse CTE list: name [col list] AS ( ... ) [, name AS ( ... )]...
    while (i < stmt.length) {
      const nameTok = stmt[i];
      if (!nameTok || (nameTok.type !== "identifier" && nameTok.type !== "quoted-identifier")) break;
      const cteName = nameTok.value ?? nameTok.text;
      let j = i + 1;
      // optional column list (col1, col2)
      let declaredCols: ColumnRef[] | undefined;
      const openTok = stmt[j];
      if (openTok && openTok.text === "(") {
        const closeIdx = findMatchingParen(stmt, j);
        if (closeIdx > 0) {
          declaredCols = splitTopLevelCommas(stmt.slice(j + 1, closeIdx))
            .map((p) => p.map((t) => t.text).join("").trim())
            .filter(Boolean)
            .map((name) => ({ name, key: name.toLowerCase() }));
          j = closeIdx + 1;
        }
      }
      if (upperAt(stmt, j) !== "AS") break;
      j++;
      const openTok2 = stmt[j];
      if (!openTok2 || openTok2.text !== "(") break;
      const closeIdx = findMatchingParen(stmt, j);
      if (closeIdx < 0) break;
      const inner = stmt.slice(j + 1, closeIdx);
      // resolve CTE columns: from declared list, else from inner SELECT projection
      const cols = declaredCols ?? extractCteProjection(inner, graph);
      cteColumns.set(cteName.toLowerCase(), cols);
      i = closeIdx + 1;
      // skip trailing comma or continue
      const nextTok = stmt[i];
      if (nextTok && nextTok.text === ",") {
        i++;
        continue;
      }
      break;
    }
  }

  // Second pass: walk statement collecting FROM/JOIN/UPDATE/INTO relations.
  for (let k = 0; k < stmt.length; k++) {
    const kw = upperAt(stmt, k);
    if (kw === "FROM" || kw === "JOIN" || kw === "UPDATE" || kw === "INTO") {
      const isJoin = kw === "JOIN";
      // skip join modifiers
      let m = k + 1;
      while (upperAt(stmt, m) === "INNER" || upperAt(stmt, m) === "LEFT" || upperAt(stmt, m) === "RIGHT" || upperAt(stmt, m) === "FULL" || upperAt(stmt, m) === "CROSS" || upperAt(stmt, m) === "OUTER" || upperAt(stmt, m) === "LATERAL") m++;
      const rel = parseRelationRef(stmt, m, graph, cteColumns);
      if (rel) {
        // find alias after relation (AS alias or bare alias)
        let next = rel.endIndex + 1;
        if (upperAt(stmt, next) === "AS") next++;
        const aliasTok = stmt[next];
        if (aliasTok && (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier") && !KEYWORDS.has(aliasTok.text.toUpperCase())) {
          rel.alias = aliasTok.value ?? aliasTok.text;
        }
        map.visibleRelations.push(rel);
        k = rel.endIndex + (rel.alias ? (stmt[rel.endIndex + 1]?.text === "AS" ? 2 : 1) : 0);
      }
    }
  }
}

function parseRelationRef(
  stmt: Token[],
  from: number,
  graph: SchemaGraph | null,
  cteColumns: Map<string, ColumnRef[]>
): (RelationRef & { endIndex: number }) | null {
  // Could be:
  //  - schema.name
  //  - name
  //  - (subquery) alias
  //  - function(...)
  const t = stmt[from];
  if (!t) return null;
  if (t.text === "(") {
    // subquery — we won't deeply analyze; return anonymous relation
    const closeIdx = findMatchingParen(stmt, from);
    if (closeIdx < 0) return null;
    const cols = extractCteProjection(stmt.slice(from + 1, closeIdx), graph);
    return {
      key: `__subquery_${from}`,
      name: "",
      columns: cols,
      endIndex: closeIdx,
    };
  }
  if (t.type !== "identifier" && t.type !== "quoted-identifier") return null;
  const firstName = t.value ?? t.text;
  // schema.name?
  const dotTok = stmt[from + 1];
  const relTok = stmt[from + 2];
  if (dotTok && dotTok.text === "." && relTok && (relTok.type === "identifier" || relTok.type === "quoted-identifier")) {
    const relName = relTok.value ?? relTok.text;
    const rel = graph ? getRelation(graph, firstName, relName, t.type === "quoted-identifier", relTok.type === "quoted-identifier") : null;
    return {
      key: `${firstName.toLowerCase()}.${relName.toLowerCase()}`,
      schema: firstName,
      name: relName,
      columns: rel ? rel.columns.map(columnToRef) : undefined,
      endIndex: from + 2,
    };
  }
  // bare name: could be CTE or relation in default search_path (we try public)
  const bareKey = firstName.toLowerCase();
  if (cteColumns.has(bareKey)) {
    return {
      key: bareKey,
      name: firstName,
      cteName: firstName,
      columns: cteColumns.get(bareKey),
      endIndex: from,
    };
  }
  if (graph) {
    // try public schema first
    const rel = getRelation(graph, "public", firstName, false, t.type === "quoted-identifier");
    if (rel) {
      return {
        key: `public.${bareKey}`,
        schema: "public",
        name: firstName,
        columns: rel.columns.map(columnToRef),
        endIndex: from,
      };
    }
    // search all schemas
    for (const sName of Object.keys(graph.schemas)) {
      const r = getRelation(graph, sName, firstName, false, t.type === "quoted-identifier");
      if (r) {
        return {
          key: `${sName}.${bareKey}`,
          schema: sName,
          name: firstName,
          columns: r.columns.map(columnToRef),
          endIndex: from,
        };
      }
    }
  }
  // unknown relation
  return { key: bareKey, name: firstName, endIndex: from };
}

function columnToRef(c: import("../types/schema-graph").ColumnNode): ColumnRef {
  return {
    name: c.name,
    key: c.key,
    dataType: c.dataType,
    baseType: c.baseType,
    isPrimaryKey: c.isPrimaryKey,
    isForeignKey: !!c.foreignKey,
    jsonb: c.baseType === "jsonb" || c.baseType === "json",
  };
}

function extractCteProjection(innerTokens: Token[], graph: SchemaGraph | null): ColumnRef[] {
  // If inner is "SELECT col1, col2, alias.* FROM ..." return those names.
  const kwSelect = upperAt(innerTokens, 0);
  if (kwSelect !== "SELECT" && kwSelect !== "TABLE" && kwSelect !== "VALUES") return [];
  if (kwSelect === "VALUES") return [];
  if (kwSelect === "TABLE") {
    // TABLE rel -> all columns of rel
    const ref = innerTokens[1];
    if (!ref) return [];
    const rel = graph ? resolveRelationByName(innerTokens, 1, graph) : null;
    return rel?.columns.map(columnToRef) ?? [];
  }
  // SELECT projection list ends at FROM (top-level)
  const fromIdx = findTopLevelKeyword(innerTokens, "FROM", 1);
  const projEnd = fromIdx < 0 ? innerTokens.length : fromIdx;
  const proj = innerTokens.slice(1, projEnd);
  const parts = splitTopLevelCommas(proj);
  const cols: ColumnRef[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    // `*` -> skip (we cannot reliably expand; conservative)
    if (part.length === 1 && part[0]!.text === "*") continue;
    // alias.*  -> skip
    if (part.length === 3 && part[1]!.text === "." && part[2]!.text === "*") continue;
    // expr [AS] alias  -> use alias
    const asIdx = part.findIndex((t) => t.type === "keyword" && t.text.toUpperCase() === "AS");
    if (asIdx >= 0 && asIdx + 1 < part.length) {
      const aliasTok = part[asIdx + 1]!;
      if (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier") {
        const nm = aliasTok.value ?? aliasTok.text;
        cols.push({ name: nm, key: nm.toLowerCase() });
        continue;
      }
    }
    // bare column name (last identifier of the expression as a heuristic)
    const lastId = [...part].reverse().find((t) => t.type === "identifier" || t.type === "quoted-identifier");
    if (lastId) {
      const nm = lastId.value ?? lastId.text;
      cols.push({ name: nm, key: nm.toLowerCase() });
    }
  }
  return cols;
}

function resolveRelationByName(tokens: Token[], at: number, graph: SchemaGraph): { columns: import("../types/schema-graph").ColumnNode[] } | null {
  const t = tokens[at];
  if (!t) return null;
  const dotTok = tokens[at + 1];
  const relTok = tokens[at + 2];
  if (dotTok && dotTok.text === "." && relTok) {
    return getRelation(graph, t.value ?? t.text, relTok.value ?? relTok.text, t.type === "quoted-identifier", relTok.type === "quoted-identifier");
  }
  // bare name -> public then any
  return getRelation(graph, "public", t.value ?? t.text, false, t.type === "quoted-identifier") ?? findRelationAnySchema(graph, t.value ?? t.text);
}

function findRelationAnySchema(graph: SchemaGraph, name: string) {
  const lower = name.toLowerCase();
  for (const s of Object.values(graph.schemas)) {
    for (const r of Object.values(s.relations)) {
      if (r.name.toLowerCase() === lower) return r;
    }
  }
  return null;
}

// ---- cursor classification ----

function classifyCursor(
  stmt: LocatedStatement,
  cursor: number,
  sql: string,
  map: RelationMap,
  graph: SchemaGraph | null
): { kind: CompletionContextKind; from: number; to: number; prefix: string } {
  // Find the token immediately before the cursor in the statement (significant only).
  const sig = significantTokensBefore(stmt.tokens, cursor);
  if (sig.length === 0) {
    // at statement start
    return { kind: "keyword", from: cursor, to: cursor, prefix: "" };
  }
  const prev = sig[sig.length - 1]!;
  const prevPrev = sig[sig.length - 2];
  const prevText = prev.text;
  const prevUpper = prevText.toUpperCase();

  // JSONB path operator
  if (prevText === "->" || prevText === "->>" || prevText === "#>" || prevText === "#>>") {
    // need active relation + column: find the column token before the operator
    const colTok = prevPrev;
    if (colTok) {
      const rel = resolveRelationForPrefix(stmt.tokens, colTok, map);
      const column = (colTok.value ?? colTok.text).toLowerCase();
      if (rel) {
        map.jsonb = {
          relation: rel,
          column,
          operator: prevText as "->" | "->>" | "#>" | "#>>",
        };
      }
    }
    return { kind: "jsonb-path", from: cursor, to: cursor, prefix: "" };
  }

  // qualified column: alias. or schema.relation.
  if (prevText === ".") {
    const qualifierTok = prevPrev;
    if (qualifierTok) {
      const qualifier = qualifierTok.value ?? qualifierTok.text;
      const qualifierUpper = qualifier.toUpperCase();
      // is qualifier a known alias or CTE?
      const aliasRel = map.visibleRelations.find((r) => r.alias?.toLowerCase() === qualifier.toLowerCase());
      if (aliasRel) {
        map.activeAlias = qualifier;
        map.activeRelation = aliasRel;
        return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
      }
      // is qualifier a relation name (schema.table. pattern handled below)?
      const relByName = map.visibleRelations.find((r) => r.name.toLowerCase() === qualifier.toLowerCase());
      if (relByName) {
        map.activeRelation = relByName;
        return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
      }
      // is qualifier a schema name?
      if (graph && lookupSchemas(graph, qualifier).length > 0) {
        return { kind: "schema", from: cursor, to: cursor, prefix: "" };
      }
    }
    return { kind: "qualified-column", from: cursor, to: cursor, prefix: "" };
  }

  // context keywords
  if (isRelationContextKeyword(prevUpper)) {
    return { kind: "relation", from: cursor, to: cursor, prefix: "" };
  }
  // INSERT INTO table ( -> insert-column
  if (prevText === "(" && prevPrev && (prevPrev.text.toUpperCase() === "INTO" || isRelationNameToken(prevPrev))) {
    return { kind: "insert-column", from: cursor, to: cursor, prefix: "" };
  }
  // VALUES ( -> insert-value
  if (prevUpper === "VALUES") {
    return { kind: "insert-value", from: cursor, to: cursor, prefix: "" };
  }
  // WITH name AS ( -> cte context after AS (
  if (prevUpper === "AS" && prevPrev && prevPrev.type !== "punctuation") {
    // could be CTE; treat as relation-ish
    return { kind: "relation", from: cursor, to: cursor, prefix: "" };
  }
  if (prevUpper === "WITH") {
    return { kind: "cte-name", from: cursor, to: cursor, prefix: "" };
  }

  // Typing an identifier prefix: compute the prefix and replacement range.
  if (prev.type === "identifier" || prev.type === "quoted-identifier") {
    // The replacement range covers the identifier being typed.
    const from = prev.start;
    const to = cursor;
    const prefix = sql.slice(from, cursor);
    // determine kind by earlier significant token
    const before = sig[sig.length - 2];
    const beforeUpper = before ? before.text.toUpperCase() : "";
    if (beforeUpper === ".") {
      // qualified — handled above; fallback
      return { kind: "qualified-column", from, to, prefix };
    }
    if (isRelationContextKeyword(beforeUpper)) {
      return { kind: "relation", from, to, prefix };
    }
    if (beforeUpper === "VALUES") {
      return { kind: "insert-value", from, to, prefix };
    }
    // default: column context (SELECT/WHERE/ORDER BY etc.)
    return { kind: "column", from, to, prefix };
  }

  // after a comma in select list or where — column-ish
  if (prevText === ",") {
    return { kind: "column", from: cursor, to: cursor, prefix: "" };
  }

  // after WHERE/SELECT/etc keyword with whitespace — column context (default)
  if (isColumnContextKeyword(prevUpper)) {
    return { kind: "column", from: cursor, to: cursor, prefix: "" };
  }

  // default fallback
  return { kind: "unknown", from: cursor, to: cursor, prefix: "" };
}

function significantTokensBefore(stmtTokens: Token[], cursor: number): Token[] {
  const sig = significantTokens(stmtTokens).filter((t) => t.start < cursor);
  // also include a token if cursor is right at its end
  return sig;
}

function resolveRelationForPrefix(stmtTokens: Token[], colTok: Token, map: RelationMap): RelationRef | undefined {
  // if preceded by "alias." or "schema.relation." use that; else infer from single visible relation
  const idx = stmtTokens.indexOf(colTok);
  if (idx >= 2 && stmtTokens[idx - 1]!.text === ".") {
    const qualifier = stmtTokens[idx - 2]!;
    const qName = qualifier.value ?? qualifier.text;
    const aliasRel = map.visibleRelations.find((r) => r.alias?.toLowerCase() === qName.toLowerCase() || r.name.toLowerCase() === qName.toLowerCase());
    if (aliasRel) return aliasRel;
  }
  if (map.visibleRelations.length === 1) return map.visibleRelations[0];
  return undefined;
}

function isRelationContextKeyword(kw: string): boolean {
  return kw === "FROM" || kw === "JOIN" || kw === "INTO" || kw === "UPDATE" || kw === "TABLE";
}

function isColumnContextKeyword(kw: string): boolean {
  return (
    kw === "SELECT" || kw === "WHERE" || kw === "ON" || kw === "GROUP" || kw === "ORDER" ||
    kw === "HAVING" || kw === "BY" || kw === "AND" || kw === "OR" || kw === "RETURNING" || kw === "SET"
  );
}

function isRelationNameToken(t: Token): boolean {
  return t.type === "identifier" || t.type === "quoted-identifier";
}

function unknownContext(from: number, to: number, prefix: string): CompletionContext {
  return {
    kind: "unknown",
    from,
    to,
    prefix,
    visibleRelations: [],
  };
}

// ---- shared low-level helpers (kept local to avoid coupling to ddl-parser) ----

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

function findTopLevelKeyword(tokens: Token[], kw: string, from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === "keyword" && t.text.toUpperCase() === kw) return i;
  }
  return -1;
}

function upperAt(stmt: Token[], i: number): string {
  if (i < 0 || i >= stmt.length) return "";
  return stmt[i]!.text.toUpperCase();
}
