// JSONB Field annotation parser (SPEC §5.4).
// Format: `-- @pg4-jsonb <schema>.<table>.<column> <path>:<type> ["comment"]`
// path uses `.` segments; `[]` denotes array; JSON Pointer escape for special chars.
// Returns warnings rather than throwing on bad input.

import type { JsonbPathNode } from "../types/schema-graph";
import type { DdlWarning } from "../types/editor";

export interface ParsedJsonbAnnotation {
  schema: string;
  table: string;
  column: string;
  segments: string[];
  valueType?: string;
  comment?: string;
}

const ANNOT_PREFIX = "@pg4-jsonb";

export function extractJsonbAnnotations(rawDdl: string): {
  annotations: ParsedJsonbAnnotation[];
  warnings: DdlWarning[];
} {
  const annotations: ParsedJsonbAnnotation[] = [];
  const warnings: DdlWarning[] = [];
  const lines = rawDdl.split("\n");
  lines.forEach((lineText, idx) => {
    const line = lineText.trim();
    if (!line.startsWith("--")) return;
    const afterDashes = line.slice(2).trim();
    if (!afterDashes.startsWith(ANNOT_PREFIX)) return;
    const rest = afterDashes.slice(ANNOT_PREFIX.length).trim();
    const parsed = parseOneAnnotation(rest, idx + 1, lineText);
    if ("error" in parsed) {
      warnings.push({
        line: idx + 1,
        excerpt: truncate(lineText, 120),
        code: "jsonb-annotation",
        message: parsed.error,
      });
      return;
    }
    annotations.push(parsed);
  });
  return { annotations, warnings };
}

function parseOneAnnotation(
  rest: string,
  lineNo: number,
  raw: string
): ParsedJsonbAnnotation | { error: string } {
  // target: `schema.table.column`
  // path: `<path>:<type>`
  // optional quoted comment
  // We must split path from comment carefully because path may not contain spaces but JSON pointer escape can.
  // Strategy: first extract trailing quoted comment if present.
  let comment: string | undefined;
  let core = rest;
  const quotedComment = core.match(/"([^"]*)"\s*$/);
  if (quotedComment) {
    comment = quotedComment[1];
    core = core.slice(0, quotedComment.index).trim();
  }

  // Split into target + pathType by first whitespace.
  const firstSpace = core.search(/\s/);
  if (firstSpace < 0) {
    return { error: "missing path specification" };
  }
  const target = core.slice(0, firstSpace).trim();
  const pathType = core.slice(firstSpace + 1).trim();

  const targetParts = target.split(".");
  if (targetParts.length !== 3 || targetParts.some((p) => !p)) {
    return { error: `invalid target "${target}", expected schema.table.column` };
  }
  const [schema, table, column] = targetParts as [string, string, string];

  // path: may be empty (means root)? Spec requires path. Split type off by last colon.
  // But JSON Pointer escape uses / ~1; colons are not part of pointer. Safe to split by last `:`.
  const colonIdx = pathType.lastIndexOf(":");
  let pathStr: string;
  let valueType: string | undefined;
  if (colonIdx < 0) {
    pathStr = pathType;
  } else {
    pathStr = pathType.slice(0, colonIdx).trim();
    valueType = pathType.slice(colonIdx + 1).trim() || undefined;
  }
  if (!pathStr) {
    return { error: "empty path" };
  }
  const segments = parsePathSegments(pathStr, lineNo, raw);
  if (segments.length === 0) {
    return { error: "could not parse path segments" };
  }
  return { schema, table, column, segments, valueType, comment };
}

function parsePathSegments(pathStr: string, lineNo: number, raw: string): string[] {
  // Two notations supported:
  //  1. dotted: customer.profile.name   (use [] for array: items[].sku)
  //  2. JSON Pointer: /customer/profile/name  (~1 for /, ~0 for ~)
  const segments: string[] = [];
  if (pathStr.startsWith("/")) {
    // JSON Pointer
    const parts = pathStr.split("/").slice(1);
    for (const p of parts) {
      const seg = p.replace(/~1/g, "/").replace(/~0/g, "~");
      if (seg === "" || seg === "-") continue;
      segments.push(seg);
    }
    return segments;
  }
  // dotted with optional []
  // split on `.`, treat `key[]` -> key + array marker (encoded as `key[]` to preserve array-ness)
  const parts = pathStr.split(".");
  for (const p of parts) {
    if (!p) continue;
    segments.push(p);
  }
  return segments;
}

/** Build a JsonbPathNode tree from annotations for one column. */
export function buildJsonbTree(annotations: ParsedJsonbAnnotation[]): {
  roots: JsonbPathNode[];
  warnings: DdlWarning[];
} {
  const warnings: DdlWarning[] = [];
  const roots: JsonbPathNode[] = [];

  for (const ann of annotations) {
    // walk/build the tree
    let level = roots;
    for (let i = 0; i < ann.segments.length; i++) {
      const segRaw = ann.segments[i]!;
      const isArray = segRaw.endsWith("[]");
      const name = isArray ? segRaw.slice(0, -2) : segRaw;
      if (!name) {
        warnings.push({
          line: 0,
          excerpt: ann.segments.join("."),
          code: "jsonb-path",
          message: `empty segment in path "${ann.segments.join(".")}"`,
        });
        break;
      }
      const isLeaf = i === ann.segments.length - 1;
      let node = level.find((n) => n.displayPath === name || lastSegment(n) === name);
      if (!node) {
        node = {
          segments: [],
          displayPath: name,
          isArray,
          valueType: isLeaf ? ann.valueType ?? "unknown" : undefined,
          nullable: undefined,
          comment: isLeaf ? ann.comment : undefined,
          children: [],
        };
        level.push(node);
      } else if (isLeaf) {
        // override last declaration wins (SPEC §5.4)
        node.valueType = ann.valueType ?? node.valueType ?? "unknown";
        if (ann.comment) node.comment = ann.comment;
        if (isArray) node.isArray = true;
      } else {
        if (isArray) node.isArray = true;
      }
      level = node.children;
    }
  }

  // compute displayPath recursively
  const finalize = (nodes: JsonbPathNode[], prefix: string[]) => {
    for (const n of nodes) {
      n.segments = [...prefix, n.displayPath + (n.isArray ? "[]" : "")];
      n.displayPath = n.segments.map((s) => s.replace(/\[\]$/, "")).join(".");
      finalize(n.children, n.segments);
    }
  };
  finalize(roots, []);
  return { roots, warnings };
}

function lastSegment(node: JsonbPathNode): string {
  return node.displayPath.split(".").pop() ?? node.displayPath;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
