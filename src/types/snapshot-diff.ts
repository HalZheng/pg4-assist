// Snapshot diff result types (SPEC §8.2).

export type DiffChangeKind =
  | "added"
  | "removed"
  | "modified"
  | "rename-candidate";

export type DiffNodeKind = "schema" | "relation" | "column" | "constraint" | "function";

export interface DiffNode {
  kind: DiffNodeKind;
  /** qualified path e.g. "public.orders.id" */
  path: string[];
  change: DiffChangeKind;
  /** structured change details */
  changes?: Array<{ field: string; before?: string; after?: string }>;
  /** similarity score for rename candidates (0..1) */
  similarity?: number;
  children?: DiffNode[];
}

export interface SnapshotDiffResult {
  nodes: DiffNode[];
  /** count summary */
  summary: { added: number; removed: number; modified: number; renameCandidates: number };
}
