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

// ─── 4b. Identifier quoting (PostgreSQL case semantics) ──────────────
// PG folds unquoted identifiers to lowercase; only "quoted" ones keep case.
// Completion insertText must auto-quote identifiers that require it.
console.log("\n[4b] identifier quoting (PG case semantics)");
{
  const DDL = `
CREATE SCHEMA "Reporting";
CREATE TABLE public."Films" (
  "FilmId" integer PRIMARY KEY,
  "Title" text NOT NULL,
  release_year integer,
  "order" integer
);
CREATE TABLE public.actors (
  actor_id integer PRIMARY KEY
);
CREATE TABLE "Reporting".SalesReport (
  report_id integer PRIMARY KEY
);
`;
  const parsed = pg4.parseDdl(DDL, "case.sql");
  const g2 = parsed.graph;
  pg4.buildIndex(g2);

  // ── helper rules ──
  check("identNeedsQuote: mixed case", pg4.identNeedsQuote("Films") === true);
  check("identNeedsQuote: lowercase plain", pg4.identNeedsQuote("actors") === false);
  check("identNeedsQuote: reserved keyword `order`", pg4.identNeedsQuote("order") === true);
  check("identNeedsQuote: non-reserved keyword `name`", pg4.identNeedsQuote("name") === false);
  check("identNeedsQuote: leading digit", pg4.identNeedsQuote("1abc") === true);
  check("identNeedsQuote: space", pg4.identNeedsQuote("My Table") === true);
  check("quoteIdent escapes inner quotes", pg4.quoteIdent('Weird"Name') === '"Weird""Name"');

  // ── table completion, unquoted prefix ──
  const q1 = "SELECT * FROM fil";
  const c1 = pg4.buildCompletionContext(q1, q1.length, g2);
  const items1 = pg4.generateCandidates(c1, g2, new Map());
  const films = items1.find(i => i.label === "Films");
  check("mixed-case table offered for 'fil'", !!films);
  check("mixed-case table insertText quoted", films?.insertText === '"Films"');

  const q2 = "SELECT * FROM act";
  const c2 = pg4.buildCompletionContext(q2, q2.length, g2);
  const items2 = pg4.generateCandidates(c2, g2, new Map());
  const actors = items2.find(i => i.label === "actors");
  check("lowercase table offered for 'act'", !!actors);
  check("lowercase table insertText stays bare", actors?.insertText === "actors");

  // ── qualified-name insertText: quote only the parts that need it ──
  // Note: the table was created UNQUOTED (`SalesReport`), so PostgreSQL
  // stored it as `salesreport` — the completion must emit the folded name,
  // while the quoted schema keeps its exact case.
  const q3 = "SELECT * FROM sal";
  const c3 = pg4.buildCompletionContext(q3, q3.length, g2);
  const items3 = pg4.generateCandidates(c3, g2, new Map());
  const sr = items3.find(i => i.label === "Reporting.salesreport");
  check("cross-schema table offered for 'sal'", !!sr);
  check("cross-schema insertText quotes only the mixed-case schema", sr?.insertText === '"Reporting".salesreport');

  // ── quoted context: user typed an opening quote ──
  const q4 = 'SELECT * FROM "Fil';
  const c4 = pg4.buildCompletionContext(q4, q4.length, g2);
  check("quoted prefix includes opening quote", c4.prefix === '"Fil');
  const items4 = pg4.generateCandidates(c4, g2, new Map());
  const filmsQ = items4.find(i => i.label === "Films");
  check("quoted ctx still offers Films", !!filmsQ);
  check("quoted ctx insertText closes the quote", filmsQ?.insertText === '"Films"');

  // ── column completion after a quoted-table alias ──
  const q5 = 'SELECT f. FROM "Films" f';
  const c5 = pg4.buildCompletionContext(q5, q5.indexOf(".") + 1, g2);
  check("qualified-column after quoted table", c5.kind === "qualified-column");
  const items5 = pg4.generateCandidates(c5, g2, new Map());
  check("mixed-case column quoted", items5.some(i => i.label === "FilmId" && i.insertText === '"FilmId"'));
  check("reserved-word column quoted", items5.some(i => i.label === "order" && i.insertText === '"order"'));
  check("plain lowercase column stays bare", items5.some(i => i.label === "release_year" && i.insertText === "release_year"));

  // ── schema-relation after a quoted schema name ──
  const q6 = 'SELECT * FROM "Reporting".';
  const c6 = pg4.buildCompletionContext(q6, q6.length, g2);
  check("schema-relation after quoted schema", c6.kind === "schema-relation");
  const items6 = pg4.generateCandidates(c6, g2, new Map());
  check("table listed under quoted schema", items6.some(i => i.label === "salesreport" && i.insertText === "salesreport"));
}

// ─── 4c. EF Core default naming + closeBrackets pairing ───────────────
// EF Core (no SnakeCase) quotes every identifier in generated DDL, so the
// database stores PascalCase names ("UserInfo"."UserId"). Hand-written SQL
// MUST quote them. Completion must therefore always offer quoted forms for
// such names, and must not double up quotes when CM closeBrackets has
// already auto-inserted the closing quote.
console.log("\n[4c] EF Core default naming + closeBrackets pairing");
{
  // Realistic EF Core generated DDL (AspNetUsers-style + PascalCase domain)
  const EFDDL = `
CREATE TABLE public."UserInfo" (
  "UserId" integer PRIMARY KEY,
  "UserName" text NOT NULL,
  "CreatedAtUtc" timestamp with time zone NOT NULL
);
CREATE TABLE public."Order" (
  "OrderId" integer PRIMARY KEY,
  "UserInfoUserId" integer REFERENCES public."UserInfo"("UserId")
);
CREATE TABLE public."__EFMigrationsHistory" (
  "MigrationId" text PRIMARY KEY
);
CREATE TABLE public.tags (
  tag_id integer PRIMARY KEY
);
CREATE SCHEMA IF NOT EXISTS ef2;
CREATE TABLE IF NOT EXISTS ef2."Extra" ("ExtraId" integer PRIMARY KEY);
`;
  const p = pg4.parseDdl(EFDDL, "ef.sql");
  const g3 = p.graph;
  pg4.buildIndex(g3);

  // IF NOT EXISTS must not leak a phantom "if" schema
  check("EF: no phantom 'if' schema from IF NOT EXISTS", !g3.schemas.if);
  check("EF: ef2 schema parsed with Extra table",
    g3.schemas.ef2?.relations?.["ef2.Extra"] != null);
  check("EF: Extra insertText quoted", (() => {
    const q = "SELECT * FROM ef2.extr";
    const c = pg4.buildCompletionContext(q, q.length, g3);
    // Qualified partial routes to schema-relation: insertText is the bare
    // table part; the typed `ef2.` prefix stays in the document.
    const it = pg4.generateCandidates(c, g3, new Map()).find(i => i.label === "Extra");
    return it?.insertText === '"Extra"';
  })());

  // ── schema-qualified partial (FROM ef2.extr) must not duplicate schema ──
  // The typed `ef2.` prefix stays in the document; insertText carries only the
  // table part. Applying it over the replace range must yield correct SQL.
  {
    const q = "SELECT * FROM ef2.extr";
    const c = pg4.buildCompletionContext(q, q.length, g3);
    check("qualified partial: kind is schema-relation", c.kind === "schema-relation");
    check("qualified partial: from covers only the partial word",
      c.from === q.indexOf("extr") && c.to === q.length);
    check("qualified partial: activeSchema is ef2", c.activeSchema === "ef2");
    const items = pg4.generateCandidates(c, g3, new Map());
    const ex = items.find(i => i.label === "Extra");
    check("qualified partial: Extra offered", !!ex);
    check("qualified partial: insertText is bare table part", ex?.insertText === '"Extra"');
    const applied = q.slice(0, c.from) + ex.insertText + q.slice(c.to);
    check("qualified partial: applied SQL has no ef2.ef2. duplication",
      applied === 'SELECT * FROM ef2."Extra"');
    // Schema filtering: only ef2 tables offered (no public.tags etc.)
    check("qualified partial: candidates filtered to ef2 schema",
      items.length > 0 && items.every(i => g3.schemas.ef2?.relations?.[`ef2.${i.label}`] != null));
  }

  // ── plain (no quotes typed): PascalCase names must come back quoted ──
  const q1 = "SELECT * FROM useri";
  const c1 = pg4.buildCompletionContext(q1, q1.length, g3);
  const items1 = pg4.generateCandidates(c1, g3, new Map());
  const ui = items1.find(i => i.label === "UserInfo");
  check("EF: UserInfo offered", !!ui);
  check("EF: UserInfo insertText quoted", ui?.insertText === '"UserInfo"');

  const q1b = "SELECT * FROM __efm";
  const c1b = pg4.buildCompletionContext(q1b, q1b.length, g3);
  const items1b = pg4.generateCandidates(c1b, g3, new Map());
  check("EF: __EFMigrationsHistory quoted (leading underscores)",
    items1b.some(i => i.insertText === '"__EFMigrationsHistory"'));

  // ── qualified column: every PascalCase column quoted ──
  const q2 = 'SELECT u. FROM "UserInfo" u';
  const c2 = pg4.buildCompletionContext(q2, q2.indexOf(".") + 1, g3);
  const items2 = pg4.generateCandidates(c2, g3, new Map());
  check("EF: UserId quoted", items2.some(i => i.label === "UserId" && i.insertText === '"UserId"'));
  check("EF: UserName quoted", items2.some(i => i.label === "UserName" && i.insertText === '"UserName"'));
  check("EF: CreatedAtUtc quoted", items2.some(i => i.label === "CreatedAtUtc" && i.insertText === '"CreatedAtUtc"'));

  // ── closeBrackets pairing: caret BETWEEN the auto-inserted quote pair ──
  // Editor state after typing `SELECT * FROM "UserI` with closeBrackets ON:
  // doc = 'SELECT * FROM "UserI"' (closing quote auto-added), caret at 20
  // (right before the closing quote).
  const q3 = 'SELECT * FROM "UserI"';
  const caret3 = q3.indexOf("UserI") + "UserI".length; // 20
  const c3 = pg4.buildCompletionContext(q3, caret3, g3);
  check("closeBrackets: replace range swallows both quotes",
    c3.from === q3.indexOf('"') && c3.to === caret3 + 1);
  check("closeBrackets: prefix keeps opening quote", c3.prefix === '"UserI');
  const items3 = pg4.generateCandidates(c3, g3, new Map());
  const uiP = items3.find(i => i.label === "UserInfo");
  check("closeBrackets: UserInfo still offered", !!uiP);
  check("closeBrackets: insertText full quoted form, no doubling", uiP?.insertText === '"UserInfo"');
  // Simulate applyCompletion: replacing [from,to) with insertText must yield
  // the correct SQL.
  const applied = q3.slice(0, c3.from) + uiP.insertText + q3.slice(c3.to);
  check("closeBrackets: applied SQL correct", applied === 'SELECT * FROM "UserInfo"');

  // Same pairing for an all-lowercase table (tags): the paired-quote context
  // unifies on the quoted form — valid SQL and no quote doubling.
  const q4 = 'SELECT * FROM "tag"';
  const caret4 = q4.indexOf("tag") + 3;
  const c4 = pg4.buildCompletionContext(q4, caret4, g3);
  check("closeBrackets lowercase: range covers quotes", c4.from === q4.indexOf('"') && c4.to === caret4 + 1);
  const items4 = pg4.generateCandidates(c4, g3, new Map());
  const tag = items4.find(i => i.label === "tags");
  check("closeBrackets lowercase: tags offered", !!tag);
  check("closeBrackets lowercase: quoted form, no doubling", tag?.insertText === '"tags"');
  const applied4 = q4.slice(0, c4.from) + tag.insertText + q4.slice(c4.to);
  check("closeBrackets lowercase: applied SQL correct", applied4 === 'SELECT * FROM "tags"');

  // ── unpaired quote (closeBrackets OFF) keeps the old behavior ──
  const q5 = 'SELECT * FROM "UserI';
  const c5 = pg4.buildCompletionContext(q5, q5.length, g3);
  check("unpaired: prefix includes opening quote", c5.prefix === '"UserI');
  const items5 = pg4.generateCandidates(c5, g3, new Map());
  check("unpaired: closes the quote",
    items5.find(i => i.label === "UserInfo")?.insertText === '"UserInfo"');

  // ── qualified-column with pairing: u."UserNa" caret before close quote ──
  const q6 = 'SELECT u."UserNa" FROM "UserInfo" u';
  const caret6 = q6.indexOf("UserNa") + "UserNa".length;
  const c6 = pg4.buildCompletionContext(q6, caret6, g3);
  const items6 = pg4.generateCandidates(c6, g3, new Map());
  const un = items6.find(i => i.label === "UserName");
  check("closeBrackets qualified-column: UserName offered", !!un);
  check("closeBrackets qualified-column: no quote doubling", un?.insertText === '"UserName"');
  const applied6 = q6.slice(0, c6.from) + un.insertText + q6.slice(c6.to);
  check("closeBrackets qualified-column: applied SQL correct",
    applied6 === 'SELECT u."UserName" FROM "UserInfo" u');
}

// ─── 4d. EF Core 全引号 demo 数据库夹具（test/efcore-quoted-demo.sql） ──
console.log("\n[4d] EF Core all-quoted demo database fixture");
{
  const demoSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "efcore-quoted-demo.sql"), "utf8");
  const p = pg4.parseDdl(demoSql, "efcore-quoted-demo.sql");
  const g = p.graph;
  pg4.buildIndex(g);

  const EXPECTED_TABLES = [
    "AspNetUsers", "AspNetRoles", "AspNetUserRoles",
    "Category", "Product", "Customer", "Order", "OrderItem",
    "__EFMigrationsHistory",
  ];
  const pub = g.schemas.public;
  check("demo: exactly 9 tables in public", Object.keys(pub?.relations ?? {}).length === 9);
  for (const t of EXPECTED_TABLES) {
    check(`demo: ${t} parsed (case preserved, quoted)`,
      pub?.relations?.[`public.${t}`] != null);
  }
  // DROP/INSERT statements must not create phantom schemas/relations
  check("demo: no phantom schemas from DROP/INSERT",
    Object.keys(g.schemas).every(s => s === "public"));

  // Unqualified empty prefix: every table offered bare-quoted, no schema prefix
  const q0 = "SELECT * FROM ";
  const c0 = pg4.buildCompletionContext(q0, q0.length, g);
  const items0 = pg4.generateCandidates(c0, g, new Map());
  check("demo: empty prefix offers all 9 tables", items0.length === 9);
  check("demo: every insertText is bare quoted (no schema prefix, no bare name)",
    items0.every(i => i.insertText === '"' + i.label + '"' && !i.insertText.includes(".")));

  // Lowercase prefix matching PascalCase identifiers
  const q1 = "SELECT * FROM aspnetu";
  const c1 = pg4.buildCompletionContext(q1, q1.length, g);
  const it1 = pg4.generateCandidates(c1, g, new Map()).find(i => i.label === "AspNetUsers");
  check("demo: aspnetu → AspNetUsers offered", !!it1);
  check("demo: AspNetUsers insertText quoted", it1?.insertText === '"AspNetUsers"');

  // Reserved-word table name
  const q2 = "SELECT * FROM ord";
  const c2 = pg4.buildCompletionContext(q2, q2.length, g);
  const it2 = pg4.generateCandidates(c2, g, new Map()).find(i => i.label === "Order");
  check("demo: ord → Order offered (reserved word)", !!it2);
  check("demo: Order insertText quoted (bare ORDER is a syntax error)",
    it2?.insertText === '"Order"');
  const applied2 = q2.slice(0, c2.from) + it2.insertText + q2.slice(c2.to);
  check("demo: applied SQL is SELECT * FROM \"Order\"", applied2 === 'SELECT * FROM "Order"');

  // Leading-underscore table (EF Core migrations history)
  const q3 = "SELECT * FROM __efm";
  const c3 = pg4.buildCompletionContext(q3, q3.length, g);
  const it3 = pg4.generateCandidates(c3, g, new Map()).find(i => i.label === "__EFMigrationsHistory");
  check("demo: __efm → __EFMigrationsHistory offered", !!it3);
  check("demo: __EFMigrationsHistory insertText quoted", it3?.insertText === '"__EFMigrationsHistory"');

  // Column completion after quoted alias: every column bare-quoted
  const q4 = 'SELECT o. FROM "Order" o';
  const c4 = pg4.buildCompletionContext(q4, q4.indexOf(".") + 1, g);
  const items4 = pg4.generateCandidates(c4, g, new Map());
  for (const col of ["OrderId", "CustomerId", "OrderDate", "ShippedDate", "OrderStatus"]) {
    check(`demo: column ${col} offered quoted`,
      items4.some(i => i.label === col && i.insertText === `"${col}"`));
  }

  // FK-aware completion on the junction table alias
  const q5 = 'SELECT oi. FROM "OrderItem" oi';
  const c5 = pg4.buildCompletionContext(q5, q5.indexOf(".") + 1, g);
  const items5 = pg4.generateCandidates(c5, g, new Map());
  check("demo: OrderItem columns offered",
    ["OrderItemId", "OrderId", "ProductId", "Quantity", "UnitPrice"]
      .every(col => items5.some(i => i.label === col)));
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
