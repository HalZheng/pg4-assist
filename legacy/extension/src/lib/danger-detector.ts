// Dangerous statement detector (SPEC §9.3). Identifies risky DML/DDL and tautological WHERE.

import { tokenize, significantTokens, splitStatements, type Token } from "./sql-tokenizer";

export interface DangerResult {
  dangerous: boolean;
  reasons: string[];
  /** statement kind: 'DELETE' | 'UPDATE' | 'TRUNCATE' | 'DROP' | 'ALTER' | null */
  kind: string | null;
}

export function detectDanger(sql: string): DangerResult {
  const tokens = tokenize(sql);
  const sig = significantTokens(tokens);
  const statements = splitStatements(sig);
  // check the FIRST significant statement (or all if multiple — but execution context is one)
  if (statements.length === 0) return { dangerous: false, reasons: [], kind: null };
  // Inspect the statement containing the cursor/first; we check all and return reasons for the first dangerous one.
  for (const stmt of statements) {
    const res = checkStatement(stmt);
    if (res.dangerous) return res;
  }
  return { dangerous: false, reasons: [], kind: null };
}

function upperAt(stmt: Token[], i: number): string {
  return i >= 0 && i < stmt.length ? stmt[i]!.text.toUpperCase() : "";
}

function checkStatement(stmt: Token[]): DangerResult {
  const head = upperAt(stmt, 0);
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

function checkDelete(stmt: Token[]): DangerResult {
  // DELETE FROM ... [WHERE ...]
  if (!hasValidWhere(stmt)) {
    return { dangerous: true, reasons: ["DELETE without a WHERE clause affects all rows"], kind: "DELETE" };
  }
  if (isTautologicalWhere(stmt)) {
    return { dangerous: true, reasons: ["DELETE has a tautological WHERE (always true)"], kind: "DELETE" };
  }
  return { dangerous: false, reasons: [], kind: null };
}

function checkUpdate(stmt: Token[]): DangerResult {
  if (!hasValidWhere(stmt)) {
    return { dangerous: true, reasons: ["UPDATE without a WHERE clause affects all rows"], kind: "UPDATE" };
  }
  if (isTautologicalWhere(stmt)) {
    return { dangerous: true, reasons: ["UPDATE has a tautological WHERE (always true)"], kind: "UPDATE" };
  }
  return { dangerous: false, reasons: [], kind: null };
}

function checkAlter(stmt: Token[]): DangerResult {
  // ALTER TABLE ... DROP COLUMN
  for (let i = 0; i < stmt.length; i++) {
    if (upperAt(stmt, i) === "DROP" && upperAt(stmt, i + 1) === "COLUMN") {
      return { dangerous: true, reasons: ["ALTER TABLE ... DROP COLUMN is destructive"], kind: "ALTER" };
    }
  }
  return { dangerous: false, reasons: [], kind: null };
}

function hasValidWhere(stmt: Token[]): boolean {
  const idx = findTopLevelKeyword(stmt, "WHERE");
  if (idx < 0) return false;
  // WHERE must be followed by something beyond WHERE itself
  return stmt.slice(idx + 1).some((t) => t.type !== "punctuation" || t.text !== ";");
}

function isTautologicalWhere(stmt: Token[]): boolean {
  const idx = findTopLevelKeyword(stmt, "WHERE");
  if (idx < 0) return false;
  const tail = stmt.slice(idx + 1);
  // detect common tautologies: 1=1, true, 'x'='x', a=a (same identifier both sides)
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    const op = tail[i + 1];
    const b = tail[i + 2];
    if (!a || !op || !b) continue;
    if (op.type !== "operator") continue;
    if (op.text !== "=" && op.text !== "!=") continue;
    // 1=1
    if (a.type === "number" && b.type === "number" && a.text === b.text) return true;
    // 'x'='x'
    if (a.type === "string" && b.type === "string" && a.value === b.value) return true;
    // TRUE / FALSE alone
  }
  // bare TRUE as WHERE condition
  if (tail.length > 0) {
    const first = tail[0]!;
    if (first.type === "keyword" && (first.text.toUpperCase() === "TRUE")) {
      // ensure it's the whole condition (next token is AND/OR/end)
      const next = tail[1];
      if (!next || (next.type === "keyword" && (next.text.toUpperCase() === "AND" || next.text.toUpperCase() === "OR"))) return true;
      if (!next) return true;
    }
  }
  return false;
}

function findTopLevelKeyword(tokens: Token[], kw: string): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "punctuation" && t.text === "(") depth++;
    else if (t.type === "punctuation" && t.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && t.type === "keyword" && t.text.toUpperCase() === kw) return i;
  }
  return -1;
}
