// Editor adapter contract (SPEC §4.2) and diagnostics types.

import type { EditorStateSnapshot } from "./completion";

export interface QueryEditorAdapter {
  readonly editorId: string;
  getDocument(): string;
  getCursorOffset(): number;
  getSelection(): { from: number; to: number };
  replaceRange(from: number, to: number, insert: string): void;
  getCoordinates(offset: number): DOMRect | null;
  onChange(listener: (state: EditorStateSnapshot) => void): () => void;
  onFocus(listener: () => void): void;
  destroy(): void;
}

export type EditorState = EditorStateSnapshot;

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  from: number;
  to: number;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** rule id so users can dismiss */
  ruleId: string;
}

export interface SnapshotMeta {
  snapshotId: string;
  displayName: string;
  sourceFileName: string;
  importedAt: string;
  parserVersion: number;
  /** counts for quick display */
  schemaCount: number;
  relationCount: number;
  functionCount: number;
  /** warnings count produced during parse */
  warningCount: number;
  /** original DDL size in bytes */
  rawSizeBytes: number;
}

export interface HostBinding {
  origin: string;
  snapshotId: string | null;
  updatedAt: string;
}

export interface UsageStat {
  /** "schema.relation.column" or "schema.relation" or "function key" */
  symbolKey: string;
  snapshotId: string;
  frequency: number;
  lastUsedAt: number;
  /** per-session counter, reset on tab reload */
  localFrequency: number;
}

export interface QueryHistoryEntry {
  id?: number;
  sql: string;
  executedAt: number;
  snapshotId: string | null;
  origin: string;
  label?: string;
}

export interface Snippet {
  id: string;
  title: string;
  category: string;
  body: string;
  description?: string;
  variables: Array<{ name: string; defaultValue?: string; required: boolean }>;
  updatedAt: string;
  useCount: number;
}

export interface DdlWarning {
  line: number;
  excerpt: string;
  code: string;
  message: string;
}

export interface DdlParseResult {
  graph: import("./schema-graph").SchemaGraph;
  warnings: DdlWarning[];
}

export interface DdlParseProgress {
  phase: "reading" | "tokenizing" | "parsing" | "indexing" | "done" | "error";
  processed: number;
  total: number;
  message?: string;
}
