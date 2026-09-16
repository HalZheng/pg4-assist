// PG4 Smart Assist — esbuild bundler for Manifest V3.
// Bundles every entry point separately (content script as IIFE, service worker & worker as ESM,
// options/popup as IIFE) and copies static assets (manifest, html, icons) into dist/.
import * as esbuild from "esbuild";
import { writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "src");
const PUBLIC = resolve(__dirname, "public");
const DIST = resolve(__dirname, "dist");
const isWatch = process.argv.includes("--watch");

// Each entry: [srcPath, outfile, format]
const entries = [
  ["background/service-worker.ts", "service-worker.js", "esm"],
  ["content/content-script.ts", "content-script.js", "iife"],
  ["bridge/main-world-bridge.ts", "main-world-bridge.js", "iife"],
  ["worker/parser-worker.ts", "parser-worker.js", "esm"],
  ["options/options.ts", "options/options.js", "iife"],
  ["popup/popup.ts", "popup/popup.js", "iife"],
];

const commonOptions = {
  bundle: true,
  target: "chrome120",
  platform: "browser",
  logLevel: "info",
  legalComments: "none",
  define: {
    "import.meta.env.PG4_VERSION": JSON.stringify("0.1.0"),
  },
};

function buildOptions(srcFile, outFile, format) {
  return {
    ...commonOptions,
    entryPoints: [resolve(SRC, srcFile)],
    outfile: resolve(DIST, outFile),
    format,
  };
}

async function copyStatic() {
  await mkdir(DIST, { recursive: true });
  if (existsSync(PUBLIC)) {
    await cp(PUBLIC, DIST, { recursive: true });
  }
  await writeFile(
    resolve(DIST, "VERSION.json"),
    JSON.stringify({ version: "0.1.0", builtAt: new Date().toISOString() }),
    "utf8"
  );
}

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await copyStatic();
  await Promise.all(entries.map(([src, out, fmt]) => esbuild.build(buildOptions(src, out, fmt))));
  console.log("[pg4] build complete ->", DIST);
}

async function watch() {
  await copyStatic();
  for (const [src, out, fmt] of entries) {
    const ctx = await esbuild.context(buildOptions(src, out, fmt));
    await ctx.watch();
  }
  console.log("[pg4] watching... (Ctrl+C to stop)");
}

if (isWatch) {
  watch();
} else {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
