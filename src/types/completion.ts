// Completion context & item types (SPEC §6.2, §6.5).

export type CompletionContextKind =
  | "relation"
  | "schema"
  | "column"
  | "qualified-column"
  | "function"
  | "keyword"
  | "cte-name"
  | "jsonb-path"
  | "insert-column"
  | "insert-value"
  | "type"
  | "unknown";

export interface RelationRef {
  /** "schema.relation" lowercased, or just "relation" if schema unknown */
  key: string;
  schema?: string;
  name: string;
  alias?: string;
  /** CTE name if this relation is a CTE */
  cteName?: string;
  /** resolved columns (from schema graph or CTE projection) */
  columns?: ColumnRef[];
}

export interface ColumnRef {
  name: string;
  key: string;
  dataType?: string;
  baseType?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  jsonb?: boolean;
}

export interface CompletionContext {
  kind: CompletionContextKind;
  /** range in the document to replace */
  from: number;
  to: number;
  /** current text being typed (prefix to filter) */
  prefix: string;
  activeAlias?: string;
  activeRelation?: RelationRef;
  visibleRelations: RelationRef[];
  expectedTypes?: string[];
  jsonb?: {
    relation: RelationRef;
    column: string;
    operator: "->" | "->>" | "#>" | "#>>";
  };
}

export type CompletionItemKind =
  | "table"
  | "view"
  | "column"
  | "function"
  | "keyword"
  | "snippet"
  | "jsonb-path"
  | "cte";

export interface CompletionItem {
  kind: CompletionItemKind;
  label: string;
  detail?: string;
  documentation?: string;
  insertText: string;
  filterText: string;
  score: number;
  source: "schema" | "builtin" | "snippet" | "usage";
}

export interface EditorStateSnapshot {
  editorId: string;
  sql: string;
  cursor: number;
  selection: { from: number; to: number };
}
