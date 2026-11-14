// Bundles the Atlas shell with esbuild (Vite is the planned dev server; see documentation/development/DECISIONS.md).
// Usage: node build.mjs [--watch]
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(import.meta.url);
const extraNodePaths = (process.env.ATLAS_NODE_PATH || "").split(":").filter(Boolean);

let esbuild;
try { esbuild = require("esbuild"); }
catch { esbuild = require(require.resolve("esbuild", { paths: extraNodePaths })); }

const out = resolve(here, "dist");
mkdirSync(out, { recursive: true });
copyFileSync(resolve(here, "index.html"), resolve(out, "index.html"));

const options = {
  entryPoints: [resolve(here, "src/main.tsx")],
  bundle: true,
  outdir: out,
  entryNames: "app",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  nodePaths: extraNodePaths,
  alias: {
    "@atlas/ui/tokens.css": resolve(root, "packages/ui/src/tokens.css"),
    "@atlas/ui": resolve(root, "packages/ui/src/index.ts"),
    "@atlas/shared-types": resolve(root, "packages/shared-types/src/index.ts"),
  },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "development") },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
