// Schema Graph data model (SPEC §5.2). Stored in IndexedDB after DDL parsing.

export type SnapshotKind = "table" | "view" | "materialized-view" | "foreign-table";

export interface SchemaGraph {
  snapshotId: string;
  displayName: string;
  sourceFileName: string;
  importedAt: string;
  parserVersion: number;
  /** Schemas keyed by lowercased schema name. */
  schemas: Record<string, SchemaNode>;
  functions: FunctionNode[];
}

export interface SchemaNode {
  name: string;
  /** normalized lowercased lookup key */
  key: string;
  quoted: boolean;
  comment?: string;
  /** Relations keyed by lowercased fully-qualified name (schema.relation). */
  relations: Record<string, RelationNode>;
}

export type RelationNode = TableNode;

export interface TableNode {
  kind: SnapshotKind;
  schema: string;
  name: string;
  /** lowercased "schema.name" */
  key: string;
  quoted: boolean;
  comment?: string;
  columns: ColumnNode[];
  primaryKey: string[];
  foreignKeys: ForeignKeyNode[];
  indexes: IndexNode[];
}

export interface ColumnNode {
  name: string;
  /** lowercased lookup key within the relation */
  key: string;
  quoted: boolean;
  dataType: string;
  /** normalized lowercased base type for matching (e.g. "integer", "text", "jsonb") */
  baseType: string;
  nullable: boolean;
  defaultExpression?: string;
  comment?: string;
  ordinal: number;
  isPrimaryKey: boolean;
  foreignKey?: ForeignKeyNode;
  jsonbPaths?: JsonbPathNode[];
}

export interface ForeignKeyNode {
  name?: string;
  localColumns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface IndexNode {
  name: string;
  columns: string[];
  unique: boolean;
  partial?: boolean;
}

export interface JsonbPathNode {
  segments: string[];
  /** display path like "customer.profile.name" */
  displayPath: string;
  /** array flag for any segment */
  isArray: boolean;
  valueType?: string;
  nullable?: boolean;
  comment?: string;
  children: JsonbPathNode[];
}

export interface FunctionNode {
  schema: string;
  name: string;
  key: string;
  args: Array<{ name?: string; dataType: string; mode: "in" | "out" | "inout" | "variadic"; default?: string }>;
  returnType: string;
  language?: string;
  comment?: string;
  quoted: boolean;
}

/** Normalized lookup helpers for PostgreSQL identifier rules (SPEC §5.2).
 *
 * PostgreSQL folds UNQUOTED identifiers to lowercase, but DOUBLE-QUOTED
 * identifiers ("MyCol") keep their case exactly. `foldKey` is the single
 * canonical place that implements this rule; every key in the graph is
 * derived from it so lookups stay consistent.
 */
export function foldKey(name: string, quoted: boolean): string {
  return quoted ? name : name.toLowerCase();
}

export function normalizeIdentifier(raw: string, quoted: boolean): { name: string; key: string; quoted: boolean } {
  return {
    name: raw,
    key: foldKey(raw, quoted),
    quoted,
  };
}

/** Postgres: unquoted identifiers fold to lowercase; quoted identifiers are exact. */
export function identifierMatches(storedName: string, storedQuoted: boolean, query: string): boolean {
  const q = query.toLowerCase();
  if (storedQuoted) {
    return storedName.toLowerCase() === q || storedName === query;
  }
  return storedName.toLowerCase() === q;
}

export function relationKey(schema: string, name: string, schemaQuoted = false, nameQuoted = false): string {
  return `${foldKey(schema, schemaQuoted)}.${foldKey(name, nameQuoted)}`;
}
