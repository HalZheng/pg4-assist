// Typed RPC between the content script and the parser/index Web Worker.
// Uses a shared request/response envelope over postMessage; each call gets a unique id
// and a resolving promise. Worker-side handlers are registered via `handle`.

import type { CompletionItem, CompletionContext } from "../types/completion";
import type { SchemaGraph } from "../types/schema-graph";
import type { DdlWarning, DdlParseProgress, Diagnostic, UsageStat, Snippet } from "../types/editor";
import type { SnapshotDiffResult } from "../types/snapshot-diff";

export type WorkerRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "set-active-graph"; graph: SchemaGraph | null }
  | { id: string; type: "set-usage"; usage: UsageStat[] }
  | { id: string; type: "set-snippets"; snippets: Snippet[] }
  | { id: string; type: "set-config"; maxCandidates: number }
  | { id: string; type: "record-usage"; symbolKey: string }
  | { id: string; type: "complete"; sql: string; cursor: number; editorId: string }
  | { id: string; type: "diagnose"; sql: string; cursor: number }
  | { id: string; type: "resolve-hover"; symbol: string; sql: string; cursor: number }
  | { id: string; type: "jsonb-tree"; relationKey: string; column: string }
  | { id: string; type: "parse-ddl"; raw: string; sourceFileName: string; snapshotId: string; displayName: string }
  | { id: string; type: "diff-snapshots"; a: SchemaGraph; b: SchemaGraph }
  | { id: string; type: "detect-danger"; sql: string };

export type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export type WorkerProgress = { id: string; type: "progress"; progress: DdlParseProgress };

// Per-call result types (cast on the caller side):
export interface WorkerResults {
  ping: { pong: true; version: string };
  "set-active-graph": { acknowledged: true };
  "set-usage": { acknowledged: true };
  "set-snippets": { acknowledged: true };
  "set-config": { acknowledged: true };
  "record-usage": { acknowledged: true };
  complete: { items: CompletionItem[]; context: CompletionContext };
  diagnose: { diagnostics: Diagnostic[] };
  "resolve-hover": { documentation: HoverDoc | null };
  "jsonb-tree": { paths: import("../types/schema-graph").JsonbPathNode[] };
  "parse-ddl": { graph: SchemaGraph; warnings: DdlWarning[] };
  "diff-snapshots": SnapshotDiffResult;
  "detect-danger": { dangerous: boolean; reasons: string[]; kind: string | null };
}

export interface HoverDoc {
  qualifiedName: string;
  kind: "relation" | "column" | "function";
  dataType?: string;
  nullable?: boolean;
  defaultExpression?: string;
  comment?: string;
  primaryKey?: string[];
  foreignKey?: string;
  jsonbRootCount?: number;
  detail: string;
}

type Handler<T extends WorkerRequest["type"]> = (
  req: Extract<WorkerRequest, { type: T }>
) => Promise<WorkerResults[T]> | WorkerResults[T];

const HANDLER_TYPES = [
  "ping",
  "set-active-graph",
  "set-usage",
  "set-snippets",
  "set-config",
  "record-usage",
  "complete",
  "diagnose",
  "resolve-hover",
  "jsonb-tree",
  "parse-ddl",
  "diff-snapshots",
  "detect-danger",
] as const;

export class WorkerRpcClient {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private progressListener: ((p: DdlParseProgress) => void) | null = null;
  private seq = 0;

  constructor(private worker: Worker) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message || "worker error"));
    });
  }

  private onMessage = (ev: MessageEvent) => {
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.type === "progress" && typeof data.id === "string") {
      this.progressListener?.(data.progress as DdlParseProgress);
      return;
    }
    if (typeof data.id !== "string") return;
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    if (data.ok === true) p.resolve(data.result);
    else p.reject(new Error(data.error?.message || "worker error"));
  };

  onProgress(cb: (p: DdlParseProgress) => void) {
    this.progressListener = cb;
  }

  call<T extends WorkerRequest["type"]>(type: T, payload: Omit<Extract<WorkerRequest, { type: T }>, "id" | "type">): Promise<WorkerResults[T]> {
    const id = `${type}-${this.seq++}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<WorkerResults[T]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req = { id, type, ...payload } as WorkerRequest;
      this.worker.postMessage(req);
    });
  }

  terminate() {
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.terminate();
    for (const [, p] of this.pending) p.reject(new Error("terminated"));
    this.pending.clear();
  }
}

export class WorkerRpcServer {
  private handlers = new Map<string, Handler<any>>();

  constructor() {
    self.addEventListener("message", this.onMessage);
  }

  handle<T extends (typeof HANDLER_TYPES)[number]>(type: T, fn: Handler<T>) {
    this.handlers.set(type, fn as Handler<any>);
  }

  private onMessage = async (ev: MessageEvent) => {
    const req = ev.data as WorkerRequest;
    if (!req || typeof req.id !== "string" || typeof req.type !== "string") return;
    const fn = this.handlers.get(req.type);
    if (!fn) {
      this.reply(req.id, false, { code: "no-handler", message: `no handler for ${req.type}` });
      return;
    }
    try {
      const result = await fn(req as any);
      this.reply(req.id, true, result);
    } catch (e: any) {
      this.reply(req.id, false, { code: "handler-error", message: e?.message ?? String(e) });
    }
  };

  private reply(id: string, ok: boolean, payload: unknown) {
    const msg: WorkerResponse | WorkerProgress =
      ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload as any };
    (self as DedicatedWorkerGlobalScope).postMessage(msg);
  }

  emitProgress(id: string, progress: DdlParseProgress) {
    const msg: WorkerProgress = { id, type: "progress", progress };
    (self as DedicatedWorkerGlobalScope).postMessage(msg);
  }
}
