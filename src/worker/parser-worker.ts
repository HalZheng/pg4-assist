// Parser/Index Web Worker (SPEC §3.2). Runs DDL parse, diagnostics, completion, diff
// off the main thread. Holds the active schema graph + usage in memory for sub-50ms completion.

import { WorkerRpcServer } from "../runtime/worker-rpc";
import { parseDdl, DDL_PARSER_VERSION } from "../lib/ddl-parser";
import { buildIndex } from "../lib/schema-index";
import { buildCompletionContext } from "../lib/context-parser";
import { buildCandidates } from "../lib/completion-engine";
import { diagnose } from "../lib/diagnostics";
import { detectDanger } from "../lib/danger-detector";
import { diffSnapshots } from "../lib/snapshot-diff";
import type { SchemaGraph } from "../types/schema-graph";
import type { UsageStat, Snippet } from "../types/editor";
import type { HoverDoc } from "../runtime/worker-rpc";
import type { JsonbPathNode } from "../types/schema-graph";

const server = new WorkerRpcServer();

// In-memory state
let activeGraph: SchemaGraph | null = null;
let activeSnapshotId: string | null = null;
let usageStats: UsageStat[] = [];
let localUsage = new Map<string, number>();
let snippets: Snippet[] = [];
let maxCandidates = 50;

server.handle("ping", async () => ({ pong: true as const, version: DDL_PARSER_VERSION.toString() }));

server.handle("set-active-graph", async (req) => {
  activeGraph = req.graph;
  // reset local usage on graph switch
  localUsage = new Map();
  if (activeGraph) {
    activeSnapshotId = activeGraph.snapshotId;
  } else {
    activeSnapshotId = null;
    usageStats = [];
  }
  return { acknowledged: true as const };
});

server.handle("set-usage", async (req) => {
  usageStats = req.usage ?? [];
  return { acknowledged: true as const };
});

server.handle("set-snippets", async (req) => {
  snippets = req.snippets ?? [];
  return { acknowledged: true as const };
});

server.handle("set-config", async (req) => {
  maxCandidates = req.maxCandidates;
  return { acknowledged: true as const };
});

server.handle("record-usage", async (req) => {
  const k = req.symbolKey.toLowerCase();
  localUsage.set(k, (localUsage.get(k) ?? 0) + 1);
  return { acknowledged: true as const };
});

server.handle("complete", async (req) => {
  if (!activeGraph && usageStats.length === 0 && snippets.length === 0) {
    // no data — still return keywords via unknown context
  }
  const context = buildCompletionContext({ sql: req.sql, cursor: req.cursor, graph: activeGraph });
  const deps = {
    graph: activeGraph,
    usage: usageStats,
    snapshotId: activeSnapshotId,
    localUsage,
    snippets,
    maxCandidates,
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
  // Resolve the symbol at/around cursor. Simplified: find the token under cursor.
  const doc = resolveHoverDoc(req.symbol, activeGraph);
  return { documentation: doc };
});

server.handle("jsonb-tree", async (req) => {
  if (!activeGraph) return { paths: [] as JsonbPathNode[] };
  const [schema] = req.relationKey.toLowerCase().split(".");
  const rel = activeGraph.schemas[schema ?? ""]?.relations[req.relationKey.toLowerCase()] ?? null;
  if (!rel) return { paths: [] };
  const col = rel.columns.find((c) => c.key === req.column.toLowerCase());
  if (!col) return { paths: [] };
  return { paths: col.jsonbPaths ?? [] };
});

server.handle("parse-ddl", async (req) => {
  // run parse, emit progress
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

function resolveHoverDoc(symbol: string, graph: SchemaGraph): HoverDoc | null {
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  // try as schema.table.column or table.column or column
  const parts = trimmed.split(".");
  if (parts.length === 3) {
    const [schema, table, col] = parts;
    const rel = graph.schemas[schema!.toLowerCase()]?.relations[`${schema!.toLowerCase()}.${table!.toLowerCase()}`] ?? null;
    if (rel) {
      const column = rel.columns.find((c) => c.key === col!.toLowerCase());
      if (column) return columnDoc(rel, column);
    }
  }
  if (parts.length === 2) {
    const [schema, table] = parts;
    const rel = graph.schemas[schema!.toLowerCase()]?.relations[`${schema!.toLowerCase()}.${table!.toLowerCase()}`] ?? null;
    if (rel) return relationDoc(rel);
    // also try table.column across schemas
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        const c = r.columns.find((c) => c.key === parts[1]!.toLowerCase());
        if (c && r.name.toLowerCase() === parts[0]!.toLowerCase()) return columnDoc(r, c);
      }
    }
  }
  if (parts.length === 1) {
    // function?
    const fn = graph.functions.find((f) => f.name.toLowerCase() === parts[0]!.toLowerCase());
    if (fn) {
      return {
        qualifiedName: `${fn.schema}.${fn.name}`,
        kind: "function",
        detail: `RETURNS ${fn.returnType} (${fn.args.map((a) => a.dataType).join(", ")})`,
        comment: fn.comment,
        dataType: fn.returnType,
      };
    }
    // relation across schemas
    for (const s of Object.values(graph.schemas)) {
      for (const r of Object.values(s.relations)) {
        if (r.name.toLowerCase() === parts[0]!.toLowerCase()) return relationDoc(r);
      }
    }
  }
  return null;
}

function relationDoc(rel: import("../types/schema-graph").TableNode): HoverDoc {
  const lines: string[] = [];
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
    detail: lines.join("\n"),
  };
}

function columnDoc(rel: import("../types/schema-graph").TableNode, col: import("../types/schema-graph").ColumnNode): HoverDoc {
  const lines: string[] = [];
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
    foreignKey: col.foreignKey ? `${col.foreignKey.referencedSchema}.${col.foreignKey.referencedTable}(${col.foreignKey.referencedColumns.join(", ")})` : undefined,
    jsonbRootCount: col.jsonbPaths?.length,
    detail: lines.join("\n"),
  };
}

function countJsonbRoots(paths: JsonbPathNode[]): number {
  return paths.length;
}

export {};
