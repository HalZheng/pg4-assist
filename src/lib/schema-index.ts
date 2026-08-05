// Schema search index builder (stored alongside SchemaGraph for fast lookups).

import type { SchemaGraph } from "../types/schema-graph";
import { foldKey } from "../types/schema-graph";
import type { SnapshotIndex } from "../storage/db";

export function buildIndex(graph: SchemaGraph): SnapshotIndex {
  const index: SnapshotIndex = { relations: {}, columns: {} };
  for (const schema of Object.values(graph.schemas)) {
    for (const rel of Object.values(schema.relations)) {
      const bareKey = rel.name.toLowerCase();
      const qualifiedKey = rel.key;
      (index.relations[bareKey] ??= []).push(qualifiedKey);
      const qualifiedKey2 = qualifiedKey; // "schema.relation"
      const cols = rel.columns.map((c) => c.key);
      index.columns[qualifiedKey2] = cols;
    }
  }
  return index;
}

export function lookupRelations(graph: SchemaGraph, prefix: string, schema?: string): { schema: string; relation: string; qualifiedKey: string }[] {
  const out: { schema: string; relation: string; qualifiedKey: string }[] = [];
  const lower = prefix.toLowerCase();
  for (const sk of schema ? [schema.toLowerCase()] : Object.keys(graph.schemas)) {
    const s = graph.schemas[sk];
    if (!s) continue;
    for (const rel of Object.values(s.relations)) {
      if (rel.name.toLowerCase().startsWith(lower) || rel.key.toLowerCase().includes(lower)) {
        out.push({ schema: rel.schema, relation: rel.name, qualifiedKey: rel.key });
      }
    }
  }
  return out;
}

export function lookupSchemas(graph: SchemaGraph, prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return Object.values(graph.schemas).filter((s) => s.name.toLowerCase().startsWith(lower)).map((s) => s.name);
}

export function getRelation(graph: SchemaGraph, schema: string, name: string, schemaQuoted = false, nameQuoted = false) {
  // Folded keys keep unquoted identifiers lowercase while preserving the case
  // of double-quoted identifiers (PostgreSQL rule). Defaulting quoted to false
  // reproduces the previous unquoted-only behavior for existing callers.
  const sk = foldKey(schema, schemaQuoted);
  const nk = foldKey(name, nameQuoted);
  return graph.schemas[sk]?.relations[`${sk}.${nk}`] ?? null;
}

export function getRelationByKey(graph: SchemaGraph, qualifiedKey: string) {
  const parts = qualifiedKey.toLowerCase().split(".");
  const schema = parts[0];
  const name = parts[1];
  if (!schema || !name) return null;
  return graph.schemas[schema]?.relations[`${schema}.${name}`] ?? null;
}
