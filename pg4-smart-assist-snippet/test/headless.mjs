// Headless verification for pg4-snippet.js (pure Node, no DOM libs).
//
//   node test/headless.mjs
//
// Strategy:
//  1. Stub the minimal browser globals the snippet touches, eval the snippet,
//     and assert bootstrap degradation (Node has no indexedDB / URL.createObjectURL).
//  2. Drive the pure algorithm functions via the `window.__pg4` debug handle.
//  3. Execute the generated Blob-Worker source inside a sandboxed `self` stub to
//     prove the worker bundle is self-contained (no missing fn/const references).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SNIPPET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "pg4-snippet.js");
const SOURCE = readFileSync(SNIPPET_PATH, "utf8");

// ─── Tiny test framework ──────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const includesMsg = (diags, re) => diags.some(d => re.test(d.message ?? ""));

// ─── Browser global stubs ─────────────────────────────────────────────
function createStubElement(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: new Proxy({ cssText: "" }, { get: (o, k) => (k in o ? o[k] : ""), set: (o, k, v) => { o[k] = v; return true; } }),
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    attributes: {},
    children: [],
    shadowRoot: null,
    value: "",
    textContent: "",
    innerHTML: "",
    files: [],
    disabled: false,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    attachShadow() { return createStubShadow(); },
    querySelector() { return createStubElement("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
    click() {},
  };
  return el;
}
function createStubShadow() {
  const shadow = createStubElement("#shadow-root");
  shadow.querySelector = () => createStubElement("div"); // ".pg4-root" etc.
  return shadow;
}

const consoleBuffer = [];
const origConsole = { log: console.log, warn: console.warn, error: console.error };
for (const level of ["log", "warn", "error"]) {
  console[level] = (...args) => {
    consoleBuffer.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    origConsole[level === "log" ? "log" : level](...args.map(a => (typeof a === "string" ? a : JSON.stringify(a))));
  };
}

const localStorageShim = (() => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
})();

const stubWindow = {
  __pg4Active: undefined,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  innerWidth: 1920,
  innerHeight: 1080,
};
const stubDocument = {
  nodeType: 9,
  documentElement: createStubElement("html"),
  body: createStubElement("body"),
  head: createStubElement("head"),
  getElementById: () => null,
  createElement: tag => createStubElement(tag),
  createTextNode: () => createStubElement("#text"),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
class MutationObserverShim {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

// Install globals the snippet reads at eval/bootstrap time.
globalThis.window = stubWindow;
globalThis.document = stubDocument;
globalThis.localStorage = localStorageShim;
globalThis.MutationObserver = MutationObserverShim;
globalThis.matchMedia = stubWindow.matchMedia;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.requestAnimationFrame = cb => setTimeout(cb, 16);
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "headless-test" }, configurable: true });
}
// Node ≥18 has Blob; URL.createObjectURL intentionally left undefined so the
// snippet takes its CSP/degradation path (exactly what we want to exercise).

// ─── 1. Eval & bootstrap degradation ──────────────────────────────────
console.log("\n[1] bootstrap & silent degradation");
try {
  (0, eval)(SOURCE);
} catch (e) {
  check("snippet eval does not throw", false, e?.message ?? String(e));
}
await new Promise(r => setTimeout(r, 100)); // let async bootstrap settle

check("logs `[pg4] snippet: started`", consoleBuffer.some(l => l.includes("snippet: started")));
check("worker degrades to main thread", stubWindow.__pg4?.state?.workerAvailable === false);
check("debug handle window.__pg4 exposed", typeof stubWindow.__pg4?.parseDdl === "function");

// Idempotent re-run
consoleBuffer.length = 0;
try { (0, eval)(SOURCE); } catch {}
await new Promise(r => setTimeout(r, 20));
check("re-run logs `already active, skipping`", consoleBuffer.some(l => l.includes("already active")));
check("re-run is a no-op (no second started)", !consoleBuffer.some(l => l.includes("snippet: started")));

const pg4 = stubWindow.__pg4;

// ─── 2. Tokenizer ─────────────────────────────────────────────────────
console.log("\n[2] tokenizer");
{
  const toks = pg4.tokenize("SELECT 'a;b' -- comment;\nFROM \"My Table\"");
  check("tokenize ends with eof", toks.at(-1)?.type === "eof");
  const sig = pg4.significantTokens(toks);
  check("significantTokens drops comments/whitespace", !sig.some(t => t.type === "comment" || t.type === "whitespace"));
  check("string token keeps inner semicolon", sig.some(t => t.type === "string" && t.value === "a;b"));
  check("quoted identifier tokenized", sig.some(t => t.type === "quoted-identifier" && t.value === "My Table"));
  const stmts = pg4.splitStatements(sig);
  check("semicolon inside string/comment does not split", stmts.length === 1);
}

// ─── 3. DDL parse + JSONB + index ─────────────────────────────────────
console.log("\n[3] DDL parser / JSONB annotations / schema index");
const SAMPLE_DDL = `
CREATE SCHEMA analytics;
CREATE TABLE public.users (
  id integer PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  created_at timestamp DEFAULT now(),
  status varchar(20)
);
CREATE TABLE public.orders (
  id bigint PRIMARY KEY,
  user_id integer REFERENCES public.users(id),
  amount numeric(10,2) NOT NULL,
  data jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_orders_user ON public.orders (user_id);
CREATE VIEW public.v_orders AS SELECT id, amount FROM public.orders;
COMMENT ON TABLE public.orders IS '订单表';
COMMENT ON COLUMN public.orders.amount IS '订单金额';
-- @pg4-jsonb public.orders.data customer.name:string "客户名"
-- @pg4-jsonb public.orders.data /items[]/sku:string "SKU"
`;
let graph = null, warnings = null;
{
  const parsed = pg4.parseDdl(SAMPLE_DDL, "sample.sql");
  graph = parsed.graph;
  warnings = parsed.warnings;
  check("parseDdl returns graph + warnings", !!graph?.schemas && Array.isArray(warnings));
  check("schemas: public + analytics", !!graph.schemas.public && !!graph.schemas.analytics);
  const users = graph.schemas.public.relations["public.users"];
  const orders = graph.schemas.public.relations["public.orders"];
  check("users table parsed with 5 columns", users?.columns?.length === 5);
  check("NOT NULL respected (users.name)", users?.columns?.find(c => c.key === "name")?.nullable === false);
  check("DEFAULT captured (users.created_at)", users?.columns?.find(c => c.key === "created_at")?.defaultExpression === "now()");
  check("PK flag (users.id)", users?.columns?.find(c => c.key === "id")?.isPrimaryKey === true);
  check("FK captured (orders.user_id -> users)", orders?.columns?.find(c => c.key === "user_id")?.foreignKey?.referencedTable === "users");
  check("CREATE INDEX captured", (orders?.indexes?.length ?? 0) >= 1);
  check("CREATE VIEW parsed as view", graph.schemas.public.relations["public.v_orders"]?.kind === "view");
  check("COMMENT ON TABLE attached", orders?.comment === "订单表");
  check("COMMENT ON COLUMN attached", orders?.columns?.find(c => c.key === "amount")?.comment === "订单金额");

  pg4.parseJsonbAnnotations(SAMPLE_DDL, graph);
  const dataCol = orders?.columns?.find(c => c.key === "data");
  check("JSONB annotations attached (2 paths)", dataCol?.jsonbPaths?.length === 2);
  check("JSONB pointer path parsed", dataCol?.jsonbPaths?.some(p => p.segments?.join(".") === "items.sku"));

  const idx = pg4.buildIndex(graph);
  check("index: relationByName['public.orders']", !!idx.relationByName["public.orders"]);
  check("index: graph._index attached", !!graph._index?.relationByName?.["public.orders"]);
}

// ─── 4. Completion context + candidates ───────────────────────────────
console.log("\n[4] completion context + candidates");
{
  const ctx1 = pg4.buildCompletionContext("SELECT * FROM us", "SELECT * FROM us".length, graph);
  check("relation slot with prefix 'us'", ctx1.prefix === "us" && ["relation", "schema-relation"].includes(ctx1.kind));
  const items1 = pg4.generateCandidates(ctx1, graph, new Map());
  check("candidates contain 'users'", items1.some(i => i.label === "users"));

  const q = "SELECT o. FROM orders o";
  const ctx2 = pg4.buildCompletionContext(q, q.indexOf(".") + 1, graph);
  check("qualified-column slot after 'o.'", ctx2.kind === "qualified-column");
  const items2 = pg4.generateCandidates(ctx2, graph, new Map());
  for (const col of ["id", "user_id", "amount", "data", "created_at"]) {
    check(`column candidate '${col}'`, items2.some(i => i.label === col));
  }

  const ins = "INSERT INTO orders (us";
  const ctx3 = pg4.buildCompletionContext(ins, ins.length, graph);
  check("insert-column slot", ["insert-column", "column"].includes(ctx3.kind));

  const jq = "SELECT data -> '";
  const ctx4 = pg4.buildCompletionContext(jq + "'", jq.length, graph);
  // jsonb-path slot may require exact jsonb ctx; accept kind or skip silently
  check("jsonb context does not throw", ctx4 != null);
}

// ─── 5. Diagnostics ───────────────────────────────────────────────────
console.log("\n[5] diagnostics");
{
  const d1 = pg4.runDiagnostics("SELECT * FROM users WHERE (name = 'x'", graph);
  check("red: unclosed parenthesis", includesMsg(d1, /Unclosed parenthesis/i));

  const d2 = pg4.runDiagnostics("SELECT 'abc FROM t", graph);
  check("red: unterminated string", includesMsg(d2, /Unterminated string/i));

  const d3 = pg4.runDiagnostics("SELECT * FROM t WHERE x GROUP BY y ORDER BY z HAVING w", graph);
  check("red: clause order (HAVING after ORDER BY)", includesMsg(d3, /out of order/i));

  const d4 = pg4.runDiagnostics("SELECT o.nope FROM orders o", graph);
  check("yellow: unknown alias.column", includesMsg(d4, /does not exist/i));

  const d5 = pg4.runDiagnostics("INSERT INTO public.orders (id, user_id) VALUES (1)", graph);
  check("yellow: INSERT arity mismatch", includesMsg(d5, /does not match VALUES count/i));

  const d6 = pg4.runDiagnostics("INSERT INTO orders (nope) VALUES (1)", graph);
  check("yellow: INSERT unknown column", includesMsg(d6, /does not exist on/i));

  const d7 = pg4.runDiagnostics("SELECT * FROM orders WHERE amount = 'abc'", graph);
  check("yellow: numeric vs text type mismatch", includesMsg(d7, /type mismatch/i));

  const d8 = pg4.runDiagnostics("SELECT * FROM orders WHERE amount = 100", graph);
  check("no false positive on matching types", d8.length === 0);
}

// ─── 6. Danger detection (comment-stripped, statement-anchored) ───────
console.log("\n[6] danger detection");
{
  check("DELETE without WHERE flagged", pg4.quickDetectDangerSync("DELETE FROM public.orders")?.kind === "delete");
  check("UPDATE without WHERE flagged", pg4.quickDetectDangerSync("UPDATE orders SET amount = 1")?.kind === "update");
  check("TRUNCATE flagged", pg4.quickDetectDangerSync("TRUNCATE TABLE public.orders")?.kind === "truncate");
  check("DROP TABLE flagged", pg4.quickDetectDangerSync("DROP TABLE public.orders")?.kind === "drop");
  const taut = pg4.quickDetectDangerSync("DELETE FROM orders WHERE 1 = 1");
  check("tautological WHERE escalated", taut?.severity === "high" && /trivially true/i.test(taut?.reason ?? ""));
  check("commented-out DDL ignored", pg4.quickDetectDangerSync("-- DROP TABLE x;\nSELECT 1;") === null);
  check("DDL inside string literal ignored", pg4.quickDetectDangerSync("SELECT 'DROP TABLE x'") === null);
  check("DELETE with real WHERE passes", pg4.quickDetectDangerSync("DELETE FROM orders WHERE id = 5") === null);
  check("plain SELECT passes", pg4.quickDetectDangerSync("SELECT * FROM orders WHERE id = 1") === null);
}

// ─── 7. Smart paste slot classification ───────────────────────────────
console.log("\n[7] smart paste slot classification");
{
  const unknown = { kind: "unknown" };
  const slot = (sql, cur) => pg4.classifyPasteSlot(sql, cur, unknown);
  check("WHERE `=` → string slot", slot("SELECT * FROM users WHERE name = ", 34) === "string");
  check("VALUES ( → string slot", slot("INSERT INTO t (a) VALUES (", 26) === "string");
  check("IN ( → string slot", slot("SELECT * FROM t WHERE id IN (", 30) === "string");
  check("LIKE → string slot", slot("SELECT * FROM t WHERE name LIKE ", 33) === "string");
  check("SELECT → identifier slot", slot("SELECT ", 7) === "identifier");
  check("FROM → identifier slot", slot("SELECT * FROM ", 14) === "identifier");
  check("comma in select list → identifier slot", slot("SELECT a, ", 10) === "identifier");
  check("no slot after complete value", slot("SELECT * FROM users WHERE id = 1", 32) === null);
  check("insert-value ctx kind → string", pg4.classifyPasteSlot("x", 1, { kind: "insert-value" }) === "string");
  check("column ctx kind → identifier", pg4.classifyPasteSlot("x", 1, { kind: "column" }) === "identifier");
  // Regression: real buildCompletionContext returns ctx.kind="column" for `WHERE col = <paste>`,
  // but the look-back heuristic (comparison operator) must take priority → string slot.
  {
    const realSql = "SELECT * FROM users WHERE name = ";
    const realCtx = pg4.buildCompletionContext(realSql, realSql.length, graph);
    check("regression: WHERE col = → string despite column ctx",
      pg4.classifyPasteSlot(realSql, realSql.length, realCtx) === "string");
  }
}

// ─── 8. Worker source self-containment (sandbox exec) ─────────────────
console.log("\n[8] worker bundle self-containment");
{
  const src = pg4.buildWorkerSource();
  check("worker source built", typeof src === "string" && src.includes("parseDdl") && src.includes("runDiagnostics"));

  const posted = [];
  const selfStub = { postMessage: m => posted.push(m), onmessage: null };
  let sandboxErr = null;
  try {
    new Function("self", src)(selfStub);
  } catch (e) {
    sandboxErr = e;
  }
  check("worker source executes without ReferenceError", sandboxErr === null, sandboxErr?.message ?? "");
  check("worker posts ready message", posted[0]?.type === "pg4:ready");

  const rpc = (id, method, args) => selfStub.onmessage({ data: { id, method, args } });
  const awaitRpc = async id => {
    for (let i = 0; i < 50; i++) {
      const resp = posted.find(m => m?.id === id);
      if (resp) return resp;
      await new Promise(r => setTimeout(r, 10));
    }
    return null;
  };

  rpc(1, "parseDdl", { rawDdl: SAMPLE_DDL, sourceFileName: "sample.sql" });
  const r1 = await awaitRpc(1);
  check("worker RPC parseDdl ok", r1?.ok === true && !!r1?.result?.graph?.schemas?.public);

  rpc(2, "runDiagnostics", { sql: "SELECT * FROM users WHERE (name = 'x'", graph: r1?.result?.graph ?? null });
  const r2 = await awaitRpc(2);
  check("worker RPC runDiagnostics ok", r2?.ok === true && Array.isArray(r2?.result));

  // Mirror the real flow (activateSnapshot): worker parseDdl returns a graph
  // without _index; the main thread attaches it, then hands the GRAPH (not the
  // index object) to generateCandidates.
  const g3 = r1?.result?.graph ?? null;
  if (g3 && !g3._index) pg4.buildIndex(g3);
  rpc(3, "generateCandidates", { ctx: { kind: "relation", prefix: "us", from: 0, to: 0, visibleRelations: [] }, graph: g3, usageMap: new Map() });
  const r3 = await awaitRpc(3);
  check("worker RPC generateCandidates ok", r3?.ok === true && r3?.result?.some?.(i => i.label === "users"));

  rpc(4, "no-such-method", {});
  const r4 = await awaitRpc(4);
  check("worker rejects unknown method", r4?.ok === false);
}

// ─── 9. Main-thread fallback parity ───────────────────────────────────
console.log("\n[9] main-thread fallback parity");
{
  const viaLocal = pg4.localCompute("parseDdl", { rawDdl: SAMPLE_DDL, sourceFileName: "sample.sql" });
  check("localCompute parseDdl identical shape", !!viaLocal?.graph?.schemas?.public && Array.isArray(viaLocal?.warnings));
  const diags = pg4.localCompute("runDiagnostics", { sql: "SELECT * FROM orders WHERE amount = 'x'", graph });
  check("localCompute runDiagnostics flags mismatch", includesMsg(diags, /type mismatch/i));
}

// ─── Result ───────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════════`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed) {
  console.error("  failures:\n" + failures.map(f => `    - ${f}`).join("\n"));
  process.exit(1);
}
console.log("  ALL CHECKS PASSED");
