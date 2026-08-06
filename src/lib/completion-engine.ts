// Completion engine (SPEC §6.3, §6.5). Builds candidates from context + schema graph
// + builtin keywords/functions + usage, scores them, sorts and truncates.

import type { CompletionContext, CompletionItem, RelationRef } from "../types/completion";
import type { SchemaGraph, ColumnNode, JsonbPathNode } from "../types/schema-graph";
import type { UsageStat, Snippet } from "../types/editor";
import { SQL_KEYWORDS, BUILTIN_FUNCTIONS, normalizeType } from "./sql-reference";
import { computeScore, sortItems, type ScoredCandidate } from "./completion-ranker";

export interface CompletionEngineDeps {
  graph: SchemaGraph | null;
  usage: UsageStat[];
  snapshotId: string | null;
  /** per-session counters keyed by symbolKey */
  localUsage: Map<string, number>;
  snippets: Snippet[];
  maxCandidates: number;
  /** when false (default), pg_catalog / information_schema / EF migration tables
   *  are hidden from relation candidates to reduce noise. */
  showSystemTables?: boolean;
}

export function buildCandidates(ctx: CompletionContext, deps: CompletionEngineDeps): { items: CompletionItem[] } {
  const usageMap = new Map<string, UsageStat>();
  for (const s of deps.usage) usageMap.set(`${s.snapshotId}|${s.symbolKey.toLowerCase()}`, s);
  const rankInputs = {
    prefix: ctx.prefix,
    usage: usageMap,
    snapshotId: deps.snapshotId ?? "",
    localUsage: deps.localUsage,
    keySymbolKeys: computeKeySymbols(ctx),
    expectedBaseTypes: ctx.expectedTypes ? new Set(ctx.expectedTypes.map(normalizeBase)) : undefined,
  };

  const candidates: ScoredCandidate[] = [];
  const graph = deps.graph;

  switch (ctx.kind) {
    case "relation":
      addRelationCandidates(candidates, graph, ctx, deps);
      addSchemaCandidates(candidates, graph, ctx);
      addKeywordCandidates(candidates, ctx, ["FROM", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "AS", "ON", "USING", "WHERE"]);
      break;
    case "schema":
      addSchemaCandidates(candidates, graph, ctx);
      break;
    case "column":
      addColumnCandidates(candidates, ctx, true, deps);
      addFunctionCandidates(candidates, ctx, graph);
      addKeywordCandidates(candidates, ctx, ["AS", "AND", "OR", "NOT", "IN", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "DESC", "ASC", "DISTINCT"]);
      // When there are no visible relations yet (e.g. user is at "SELECT s" with no
      // FROM clause), also offer statement keywords so typing "sel" surfaces SELECT
      // and the user is guided toward writing FROM. Matches VSCode SQL behaviour.
      if (ctx.visibleRelations.length === 0 && !ctx.activeRelation) {
        addKeywordCandidates(candidates, ctx, ["SELECT", "FROM", "WHERE", "JOIN", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH", "UNION", "UNION ALL", "SELECT DISTINCT"]);
      }
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
      addRelationCandidates(candidates, graph, ctx, deps);
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
      // de-noised general candidates (SPEC §6.3 fallback)
      addColumnCandidates(candidates, ctx, true);
      addFunctionCandidates(candidates, ctx, graph);
      addKeywordCandidates(candidates, ctx, ["SELECT", "FROM", "WHERE", "AND", "OR", "AS", "IN", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL"]);
      break;
  }

  // Add snippet candidates when prefix starts with `snip:` or always-on lightweight.
  addSnippetCandidates(candidates, ctx, deps.snippets);

  // Score & sort
  for (const c of candidates) {
    c.score = computeScore(c, rankInputs);
  }
  const sorted = sortItems(candidates).slice(0, deps.maxCandidates);
  // strip internal fields for the public API
  const items: CompletionItem[] = sorted.map(({ usageKey: _u, baseType: _b, ...rest }) => rest);
  return { items };
}

function normalizeBase(t: string): string {
  return t.toLowerCase().replace(/\[\]$/, "").replace(/\s*\([^)]*\)/g, "").trim();
}

function computeKeySymbols(ctx: CompletionContext): Set<string> | undefined {
  const keys = new Set<string>();
  // primary keys and foreign keys of visible relations are "key"
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
  return keys.size ? keys : undefined;
}

function matchesPrefix(label: string, prefix: string): boolean {
  if (!prefix) return true;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(p)) return true;
  // segment prefix match (camelCase / underscore / dot boundaries) so that
  // "cd" still matches "CustomerData" or "customer_data" without the broad
  // noise of a full substring includes().
  const segments = l.split(/(?=[A-Z])|[_\s.]+/).filter(Boolean);
  if (segments.some((s) => s.toLowerCase().startsWith(p))) return true;
  return false;
}

/** Reserved-word set used to decide whether an unquoted identifier needs quoting. */
const RESERVED_WORDS = new Set(SQL_KEYWORDS.map((k) => k.label.toUpperCase()));

/**
 * Wrap an identifier in double quotes when PostgreSQL would require it:
 *   - the DDL declared it quoted (mixed case preserved), or
 *   - the name contains uppercase letters / whitespace / special chars, or
 *   - the name is a reserved keyword (e.g. a table literally named "order").
 * Internal double quotes are escaped by doubling, per SQL syntax.
 */
function quoteIdentIfNeeded(name: string, quoted: boolean): string {
  if (quoted) return `"${name.replace(/"/g, '""')}"`;
  const needsQuote =
    /[A-Z]/.test(name) ||
    /[^a-z0-9_]/.test(name) ||
    /^[0-9]/.test(name) ||
    RESERVED_WORDS.has(name.toUpperCase());
  return needsQuote ? `"${name.replace(/"/g, '""')}"` : name;
}

/** System / noise schemas whose tables pollute FROM candidates by default. */
const SYSTEM_SCHEMAS = new Set(["pg_catalog", "information_schema", "pg_toast", "pg_temp", "pg_toast_temp"]);

/** EF Core migration history tables and similar noise relations. */
function isNoiseRelation(schema: string, name: string): boolean {
  if (SYSTEM_SCHEMAS.has(schema.toLowerCase())) return true;
  const lower = name.toLowerCase();
  // EF Core migration history tables
  if (lower.startsWith("__ef") || lower === "__efmigrationshistory") return true;
  // Postgres internal / stats tables
  if (lower.startsWith("pg_stat_") || lower.startsWith("pg_statio_")) return true;
  return false;
}

function addRelationCandidates(out: ScoredCandidate[], graph: SchemaGraph | null, ctx: CompletionContext, deps: CompletionEngineDeps): void {
  if (!graph) return;
  const showSystem = deps.showSystemTables ?? false;
  for (const schema of Object.values(graph.schemas)) {
    for (const rel of Object.values(schema.relations)) {
      // De-noise: hide system schemas / EF migration tables unless explicitly enabled.
      if (!showSystem && isNoiseRelation(rel.schema, rel.name)) continue;
      const label = rel.schema === "public" ? rel.name : `${rel.schema}.${rel.name}`;
      if (!matchesPrefix(label, ctx.prefix) && !matchesPrefix(rel.name, ctx.prefix)) continue;
      const kind: CompletionItem["kind"] = rel.kind === "table" ? "table" : rel.kind === "view" ? "view" : "table";
      out.push({
        kind,
        label: rel.name,
        detail: `${rel.schema}.${rel.name} (${rel.kind})`,
        documentation: rel.comment,
        insertText: quoteIdentIfNeeded(rel.name, rel.quoted),
        filterText: rel.name,
        score: 0,
        source: "schema",
        usageKey: rel.key,
        baseType: rel.kind,
      });
    }
  }
}

function addSchemaCandidates(out: ScoredCandidate[], graph: SchemaGraph | null, ctx: CompletionContext): void {
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
      source: "schema",
    });
  }
}

function addColumnCandidates(out: ScoredCandidate[], ctx: CompletionContext, includeAllVisible: boolean, _deps?: CompletionEngineDeps): void {
  if (ctx.activeRelation) {
    addColumnsFromRelation(out, ctx.activeRelation, ctx.prefix, /* qualify */ false);
    return;
  }
  if (includeAllVisible) {
    // Detect ambiguous column names (same name in >1 visible relation). Only those
    // get an "alias." prefix on insert — unambiguous columns stay bare, matching
    // VSCode SQL plugin behaviour and the confirmed strategy.
    const ambiguous = new Set<string>();
    if (ctx.visibleRelations.length > 1) {
      const seen = new Map<string, number>();
      for (const rel of ctx.visibleRelations) {
        if (!rel.columns) continue;
        const local = new Set<string>();
        for (const c of rel.columns) {
          const k = c.key;
          if (local.has(k)) continue;
          local.add(k);
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
      }
      for (const [k, n] of seen) if (n > 1) ambiguous.add(k);
    }
    for (const rel of ctx.visibleRelations) {
      addColumnsFromRelation(out, rel, ctx.prefix, ambiguous.size > 0, rel.alias, ambiguous);
    }
  }
}

function addColumnsFromRelation(
  out: ScoredCandidate[],
  rel: RelationRef,
  prefix: string,
  qualify: boolean,
  alias?: string,
  ambiguous?: Set<string>
): void {
  if (!rel.columns) {
    // CTE without known projection: offer the CTE name as a relation-like item already added elsewhere
    return;
  }
  for (const c of rel.columns) {
    if (!matchesPrefix(c.name, prefix)) continue;
    // Qualify with alias only when the column is ambiguous across visible relations
    // (multi-table) AND this relation has an alias. Bare column otherwise.
    const needsQualify = qualify && ambiguous?.has(c.key) && !!alias;
    const insertText = needsQualify ? `${alias!}.${c.name}` : c.name;
    out.push({
      kind: "column",
      label: c.name,
      detail: c.dataType ? `${rel.name ? rel.name + "." : ""}${c.name} ${c.dataType}` : c.name,
      documentation: c.dataType,
      insertText,
      filterText: c.name,
      score: 0,
      source: "schema",
      usageKey: `${rel.key}.${c.key}`,
      baseType: c.baseType,
    });
  }
}

function addQualifiedColumnCandidates(out: ScoredCandidate[], ctx: CompletionContext): void {
  if (ctx.activeRelation) {
    addColumnsFromRelation(out, ctx.activeRelation, ctx.prefix, /* qualify */ false);
  } else if (ctx.activeAlias) {
    // alias not resolved: offer nothing (avoid wrong-relation columns)
  }
}

function addFunctionCandidates(out: ScoredCandidate[], ctx: CompletionContext, graph: SchemaGraph | null): void {
  // builtin functions
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
      source: "builtin",
    });
  }
  // user-defined functions from schema graph
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
        baseType: fn.returnType,
      });
    }
  }
}

function addKeywordCandidates(out: ScoredCandidate[], ctx: CompletionContext, allowed: string[]): void {
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
      source: "builtin",
    });
  }
}

function addJsonbPathCandidates(out: ScoredCandidate[], ctx: CompletionContext, graph: SchemaGraph | null): void {
  if (!ctx.jsonb || !graph) return;
  const { relation, column } = ctx.jsonb;
  // resolve the graph column via the relation's schema/name
  const schemaNode = graph.schemas[relation.schema?.toLowerCase() ?? ""];
  let relNode: import("../types/schema-graph").TableNode | null = null;
  if (schemaNode) {
    const rk = `${schemaNode.key}.${relation.name.toLowerCase()}`;
    relNode = schemaNode.relations[rk] ?? null;
  }
  if (!relNode) {
    // fallback: search all schemas
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
      source: "schema",
    });
  }
}

interface FlatPath {
  displayPath: string;
  valueType?: string;
  comment?: string;
  insertText: string;
}

function flattenJsonbPaths(roots: JsonbPathNode[], wantJson: boolean): FlatPath[] {
  const out: FlatPath[] = [];
  const walk = (nodes: JsonbPathNode[], parentSegments: string[]): void => {
    for (const n of nodes) {
      const segments = [...parentSegments, n.displayPath + (n.isArray ? "[]" : "")];
      const cleanSegs = segments.map((s) => s.replace(/\[\]$/, ""));
      const isMulti = parentSegments.length > 0;
      const op = wantJson ? (isMulti ? "#>" : "->") : isMulti ? "#>>" : "->>";
      const insertText = isMulti
        ? `${op}'{${cleanSegs.join(",")}}'`
        : `${op}'${cleanSegs[0]}'`;
      out.push({ displayPath: n.displayPath, valueType: n.valueType, comment: n.comment, insertText });
      if (n.children.length) walk(n.children, segments);
    }
  };
  walk(roots, []);
  return out;
}

function addInsertColumnCandidates(out: ScoredCandidate[], ctx: CompletionContext): void {
  // offer columns of the target table (the single visible relation that is INSERT INTO target)
  const target = ctx.visibleRelations[0];
  if (target) addColumnsFromRelation(out, target, ctx.prefix, /* qualify */ false);
}

function addTypeCandidates(out: ScoredCandidate[], ctx: CompletionContext): void {
  const commonTypes = [
    "integer", "bigint", "smallint", "numeric", "real", "double precision", "text", "varchar",
    "bpchar", "boolean", "date", "timestamptz", "timestamp", "interval", "uuid", "json", "jsonb",
    "bytea", "inet", "cidr", "macaddr", "money", "serial", "bigserial",
  ];
  for (const t of commonTypes) {
    if (!matchesPrefix(t, ctx.prefix)) continue;
    out.push({ kind: "keyword", label: t, insertText: t, filterText: t, score: 0, source: "builtin" });
  }
}

function addSnippetCandidates(out: ScoredCandidate[], ctx: CompletionContext, snippets: Snippet[]): void {
  for (const s of snippets) {
    const trigger = `snip:${s.title.toLowerCase()}`;
    if (ctx.prefix && !trigger.includes(ctx.prefix.toLowerCase()) && !s.title.toLowerCase().includes(ctx.prefix.toLowerCase())) {
      // only show snippets when explicitly typed with snip: prefix, OR when context is keyword/unknown and prefix empty
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
      source: "snippet",
    });
  }
}
