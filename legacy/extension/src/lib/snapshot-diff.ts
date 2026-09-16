// Snapshot diff (SPEC §8.2). Structural diff between two SchemaGraph snapshots.
// Rename candidates flagged as speculative when similarity >= 0.85.

import type { SchemaGraph, TableNode, ColumnNode } from "../types/schema-graph";
import type { SnapshotDiffResult, DiffNode } from "../types/snapshot-diff";

const RENAME_SIMILARITY_THRESHOLD = 0.85;

export function diffSnapshots(a: SchemaGraph, b: SchemaGraph): SnapshotDiffResult {
  const nodes: DiffNode[] = [];
  const summary = { added: 0, removed: 0, modified: 0, renameCandidates: 0 };

  const aSchemas = new Set(Object.keys(a.schemas));
  const bSchemas = new Set(Object.keys(b.schemas));

  // schemas
  for (const sk of bSchemas) {
    if (!aSchemas.has(sk)) {
      const node: DiffNode = { kind: "schema", path: [b.schemas[sk]!.name], change: "added", children: [] };
      for (const rel of Object.values(b.schemas[sk]!.relations)) node.children!.push(...diffRelationAdded(rel));
      nodes.push(node);
      summary.added++;
    }
  }
  for (const sk of aSchemas) {
    if (!bSchemas.has(sk)) {
      const node: DiffNode = { kind: "schema", path: [a.schemas[sk]!.name], change: "removed", children: [] };
      for (const rel of Object.values(a.schemas[sk]!.relations)) node.children!.push(...diffRelationRemoved(rel));
      nodes.push(node);
      summary.removed++;
    }
  }
  // common schemas
  for (const sk of aSchemas) {
    if (!bSchemas.has(sk)) continue;
    const aSchema = a.schemas[sk]!;
    const bSchema = b.schemas[sk]!;
    const schemaNode: DiffNode = { kind: "schema", path: [aSchema.name], change: "modified", children: [] };
    diffRelationsInSchema(aSchema.relations, bSchema.relations, schemaNode, summary);
    if (schemaNode.children && schemaNode.children.length > 0) {
      nodes.push(schemaNode);
    }
  }

  // functions diff (flat)
  diffFunctions(a.functions, b.functions, nodes, summary);

  return { nodes, summary };
}

function diffRelationsInSchema(
  aRels: Record<string, TableNode>,
  bRels: Record<string, TableNode>,
  parent: DiffNode,
  summary: { added: number; removed: number; modified: number; renameCandidates: number }
): void {
  const aKeys = new Set(Object.keys(aRels));
  const bKeys = new Set(Object.keys(bRels));
  // removed relations: try to match against added ones for rename candidates
  const removedRels = [...aKeys].filter((k) => !bKeys.has(k)).map((k) => aRels[k]!);
  const addedRels = [...bKeys].filter((k) => !aKeys.has(k)).map((k) => bRels[k]!);

  for (const added of addedRels) {
    parent.children!.push({
      kind: "relation",
      path: [added.schema, added.name],
      change: "added",
      children: diffColumns([], added.columns, summary),
    });
    summary.added++;
  }
  for (const removed of removedRels) {
    parent.children!.push({
      kind: "relation",
      path: [removed.schema, removed.name],
      change: "removed",
      children: diffColumns(removed.columns, [], summary),
    });
    summary.removed++;
  }

  // rename candidates: removed relation with high similarity to an added one in same schema
  for (const removed of removedRels) {
    let best: { rel: TableNode; sim: number } | null = null;
    for (const added of addedRels) {
      if (added.schema !== removed.schema) continue;
      const sim = relationSimilarity(removed, added);
      if (sim >= RENAME_SIMILARITY_THRESHOLD && (!best || sim > best.sim)) best = { rel: added, sim };
    }
    if (best) {
      parent.children!.push({
        kind: "relation",
        path: [removed.schema, `${removed.name} -> ${best.rel.name}`],
        change: "rename-candidate",
        similarity: best.sim,
      });
      summary.renameCandidates++;
    }
  }

  // common relations: diff columns
  for (const k of aKeys) {
    if (!bKeys.has(k)) continue;
    const aRel = aRels[k]!;
    const bRel = bRels[k]!;
    const relNode: DiffNode = {
      kind: "relation",
      path: [aRel.schema, aRel.name],
      change: "modified",
      children: diffColumns(aRel.columns, bRel.columns, summary),
    };
    // also compare PK / FK / comments
    const changes: DiffNode["changes"] = [];
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
    if ((relNode.children && relNode.children.length > 0) || changes.length) {
      parent.children!.push(relNode);
    }
  }
}

function diffColumns(aCols: ColumnNode[], bCols: ColumnNode[], summary: { added: number; removed: number; modified: number; renameCandidates: number }): DiffNode[] {
  const out: DiffNode[] = [];
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
    const changes: DiffNode["changes"] = [];
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

function diffRelationAdded(rel: TableNode): DiffNode[] {
  return [{ kind: "relation", path: [rel.schema, rel.name], change: "added", children: rel.columns.map((c) => ({ kind: "column", path: [c.name], change: "added" })) }];
}

function diffRelationRemoved(rel: TableNode): DiffNode[] {
  return [{ kind: "relation", path: [rel.schema, rel.name], change: "removed", children: rel.columns.map((c) => ({ kind: "column", path: [c.name], change: "removed" })) }];
}

function diffFunctions(aFns: SchemaGraph["functions"], bFns: SchemaGraph["functions"], nodes: DiffNode[], summary: { added: number; removed: number; modified: number; renameCandidates: number }): void {
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

function argsSignature(args: SchemaGraph["functions"][number]["args"]): string {
  return args.map((a) => `${a.mode} ${a.dataType}`).join(",");
}

function relationSimilarity(a: TableNode, b: TableNode): number {
  // Jaccard over column keys + name type similarity
  const aCols = new Set(a.columns.map((c) => c.key));
  const bCols = new Set(b.columns.map((c) => c.key));
  if (aCols.size === 0 && bCols.size === 0) return 0;
  let inter = 0;
  for (const c of aCols) if (bCols.has(c)) inter++;
  const union = aCols.size + bCols.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  // type similarity: share of columns with same type
  let typeMatches = 0;
  for (const ac of a.columns) {
    const bc = b.columns.find((c) => c.key === ac.key);
    if (bc && ac.baseType === bc.baseType) typeMatches++;
  }
  const typeSim = a.columns.length === 0 ? 0 : typeMatches / a.columns.length;
  return 0.6 * jaccard + 0.4 * typeSim;
}
