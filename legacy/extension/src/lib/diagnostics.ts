// Diagnostics (SPEC §7.2). Red = syntax/structural; Yellow = static type risk.
// Conservative: only flag clear-cut issues; never raise on Postgres-legal implicit casts.

import type { Diagnostic } from "../types/editor";
import type { SchemaGraph } from "../types/schema-graph";
import { tokenize, significantTokens, splitStatements, type Token } from "./sql-tokenizer";
import { normalizeType, typesComparable } from "./sql-reference";

export interface DiagnoseInput {
  sql: string;
  cursor: number;
  graph: SchemaGraph | null;
  /** when document > 500KB, only diagnose the statement containing the cursor */
  largeDoc?: boolean;
}

export function diagnose(input: DiagnoseInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { sql } = input;
  if (!sql.trim()) return diagnostics;

  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);

  // 1. Brace/paren balance per whole doc
  checkBraceBalance(tokens, diagnostics);

  // 2. Unclosed strings
  checkUnclosedStrings(tokens, diagnostics);

  // 3. Per-statement: column existence + type mismatch heuristics
  for (const stmt of statements) {
    if (stmt.length === 0) continue;
    checkStatement(stmt, diagnostics, input.graph);
  }

  // dedupe by overlapping ranges (keep most severe)
  return dedupe(diagnostics);
}

function checkBraceBalance(tokens: Token[], out: Diagnostic[]): void {
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
          ruleId: "syntax.paren",
        });
        depth = 0;
      }
    }
  }
  if (depth > 0) {
    // find last unclosed (
    let lastOpen: Token | null = null;
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
      ruleId: "syntax.paren",
    });
  }
}

function checkUnclosedStrings(tokens: Token[], out: Diagnostic[]): void {
  // our tokenizer already ensures strings are closed; an unterminated quote yields a token to EOF.
  // Detect: a string token whose text does not end with the opening quote.
  for (const t of tokens) {
    if (t.type === "eof") break;
    if (t.type === "string" && !t.text.endsWith("'")) {
      out.push({
        from: t.start,
        to: t.end,
        severity: "error",
        code: "unclosed-string",
        message: "Unclosed string literal",
        ruleId: "syntax.string",
      });
    }
  }
}

function upperAt(stmt: Token[], i: number): string {
  return i >= 0 && i < stmt.length ? stmt[i]!.text.toUpperCase() : "";
}

function checkStatement(stmt: Token[], out: Diagnostic[], graph: SchemaGraph | null): void {
  const head = upperAt(stmt, 0);
  if (head === "INSERT") checkInsert(stmt, out, graph);
  if (head === "SELECT" || head === "UPDATE" || head === "DELETE") checkComparisonTypes(stmt, out, graph);
  checkAliasColumns(stmt, out, graph);
}

function checkInsert(stmt: Token[], out: Diagnostic[], graph: SchemaGraph | null): void {
  // INSERT INTO table (cols...) VALUES (vals...) — match arity
  if (!graph) return;
  if (upperAt(stmt, 1) !== "INTO") return;
  // find table name
  let i = 2;
  // schema.table or table
  let schema = "public";
  let table = "";
  const t0 = stmt[i];
  if (!t0) return;
  if (stmt[i + 1] && stmt[i + 1]!.text === "." && stmt[i + 2]) {
    schema = t0.value ?? t0.text;
    table = stmt[i + 2]!.value ?? stmt[i + 2]!.text;
    i += 3;
  } else {
    table = t0.value ?? t0.text;
    i += 1;
  }
  // optional column list
  let cols: string[] = [];
  if (stmt[i] && stmt[i]!.text === "(") {
    const closeIdx = findMatchingParen(stmt, i);
    if (closeIdx > 0) {
      cols = splitTopLevelCommas(stmt.slice(i + 1, closeIdx))
        .map((p) => p.map((t) => t.text).join("").trim())
        .filter(Boolean);
      i = closeIdx + 1;
    }
  }
  if (!cols.length) return;
  // find VALUES
  while (i < stmt.length && upperAt(stmt, i) !== "VALUES") i++;
  if (upperAt(stmt, i) !== "VALUES") return;
  i++;
  // VALUES (...)
  if (!stmt[i] || stmt[i]!.text !== "(") return;
  const closeIdx = findMatchingParen(stmt, i);
  if (closeIdx < 0) return;
  const valuesTokens = stmt.slice(i + 1, closeIdx);
  const valuesCount = splitTopLevelCommas(valuesTokens).filter((p) => p.length > 0).length;
  if (cols.length !== valuesCount) {
    out.push({
      from: stmt[i]!.start,
      to: closeIdx + 1,
      severity: "warning",
      code: "insert-arity",
      message: `Column count (${cols.length}) does not match VALUES count (${valuesCount})`,
      ruleId: "type.insert-arity",
    });
  }
  // type-check each column vs literal where possible
  const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`];
  if (!rel) return;
  for (let k = 0; k < cols.length; k++) {
    const col = rel.columns.find((c) => c.key === cols[k]!.toLowerCase().replace(/["']/g, ""));
    if (!col) {
      out.push({
        from: 0,
        to: 0,
        severity: "warning",
        code: "unknown-column",
        message: `Column "${cols[k]}" does not exist on ${schema}.${table}`,
        ruleId: "type.unknown-column",
      });
      continue;
    }
  }
}

function checkComparisonTypes(stmt: Token[], out: Diagnostic[], graph: SchemaGraph | null): void {
  // Heuristic: find `alias.column = 'literal'` where column is numeric/text-mismatched.
  if (!graph) return;
  // Build alias -> relation columns map (very simplified)
  const aliasMap = buildAliasMap(stmt, graph);
  for (let i = 0; i < stmt.length; i++) {
    const t = stmt[i]!;
    if (t.text === "=" || t.text === "!=" || t.text === "<>" || t.text === "<" || t.text === ">" || t.text === "<=" || t.text === ">=") {
      const leftTok = stmt[i - 1];
      const rightTok = stmt[i + 1];
      if (!leftTok || !rightTok) continue;
      const leftType = inferType(leftTok, aliasMap, graph);
      const rightType = inferType(rightTok, aliasMap, graph);
      if (leftType && rightType && !typesComparable(leftType, rightType)) {
        // only flag obvious numeric-vs-text mismatches to avoid false positives
        if (isNumeric(leftType) !== isNumeric(rightType)) {
          out.push({
            from: leftTok.start,
            to: rightTok.end,
            severity: "warning",
            code: "type-mismatch",
            message: `Possible type mismatch: ${leftType} vs ${rightType}`,
            ruleId: "type.mismatch",
          });
        }
      }
    }
  }
}

function checkAliasColumns(stmt: Token[], out: Diagnostic[], graph: SchemaGraph | null): void {
  if (!graph) return;
  const aliasMap = buildAliasMap(stmt, graph);
  for (let i = 0; i < stmt.length; i++) {
    // alias.column pattern
    if (stmt[i]!.text === "." && stmt[i - 1] && stmt[i + 1]) {
      const aliasTok = stmt[i - 1]!;
      const colTok = stmt[i + 1]!;
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
          ruleId: "type.unknown-alias-column",
        });
      }
    }
  }
}

function buildAliasMap(stmt: Token[], graph: SchemaGraph): Map<string, import("../types/schema-graph").TableNode> {
  const m = new Map<string, import("../types/schema-graph").TableNode>();
  for (let i = 0; i < stmt.length; i++) {
    const kw = upperAt(stmt, i);
    if (kw === "FROM" || kw === "JOIN" || kw === "UPDATE") {
      let j = i + 1;
      while (upperAt(stmt, j) === "INNER" || upperAt(stmt, j) === "LEFT" || upperAt(stmt, j) === "RIGHT" || upperAt(stmt, j) === "FULL" || upperAt(stmt, j) === "CROSS" || upperAt(stmt, j) === "OUTER" || upperAt(stmt, j) === "LATERAL") j++;
      const t0 = stmt[j];
      if (!t0 || (t0.type !== "identifier" && t0.type !== "quoted-identifier")) continue;
      let schema = "public";
      let table = "";
      let end = j;
      if (stmt[j + 1] && stmt[j + 1]!.text === "." && stmt[j + 2]) {
        schema = t0.value ?? t0.text;
        table = stmt[j + 2]!.value ?? stmt[j + 2]!.text;
        end = j + 2;
      } else {
        table = t0.value ?? t0.text;
        end = j;
      }
      const rel = graph.schemas[schema.toLowerCase()]?.relations[`${schema.toLowerCase()}.${table.toLowerCase()}`];
      // alias
      let a = end + 1;
      if (upperAt(stmt, a) === "AS") a++;
      const aliasTok = stmt[a];
      if (aliasTok && (aliasTok.type === "identifier" || aliasTok.type === "quoted-identifier")) {
        const alias = (aliasTok.value ?? aliasTok.text).toLowerCase();
        if (rel) m.set(alias, rel);
        // also map the table name itself
        if (rel) m.set(table.toLowerCase(), rel);
      } else if (rel) {
        m.set(table.toLowerCase(), rel);
      }
    }
  }
  return m;
}

function inferType(tok: Token, aliasMap: Map<string, import("../types/schema-graph").TableNode>, graph: SchemaGraph): string | null {
  if (tok.type === "string") return "text";
  if (tok.type === "number") return "numeric";
  if (tok.type === "identifier" || tok.type === "quoted-identifier") {
    // could be alias.column
    const name = (tok.value ?? tok.text).toLowerCase();
    if (aliasMap.has(name)) return null; // alias used as relation, not value
    // search columns across all aliases (best effort)
    for (const rel of aliasMap.values()) {
      const col = rel.columns.find((c) => c.key === name);
      if (col) return col.baseType;
    }
    // search any column in graph (loose)
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        const col = r.columns.find((c) => c.key === name);
        if (col) return col.baseType;
      }
    }
  }
  return null;
}

function isNumeric(t: string): boolean {
  const b = normalizeType(t).baseType;
  return ["integer", "bigint", "smallint", "numeric", "real", "double precision"].includes(b);
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

function dedupe(diagnostics: Diagnostic[]): Diagnostic[] {
  // keep most severe (error > warning) for overlapping ranges; sort by from.
  const sorted = [...diagnostics].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Diagnostic[] = [];
  for (const d of sorted) {
    const prev = out[out.length - 1];
    if (prev && d.from < prev.to) {
      // overlap: keep more severe
      if (d.severity === "error" && prev.severity !== "error") {
        out[out.length - 1] = d;
      }
      continue;
    }
    out.push(d);
  }
  return out;
}
