import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shellDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(shellDir, "../..");
const resourceDir = resolve(shellDir, "src-tauri/target/desktop-resources");
const coreManifest = resolve(root, "crates/atlas-core/Cargo.toml");

function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  "cargo",
  ["build", "--release", "--manifest-path", coreManifest, "--bin", "atlas-core-host"],
  root,
);

rmSync(resourceDir, { recursive: true, force: true });
const binary = resolve(root, "crates/atlas-core/target/release/atlas-core-host");
const packagedBinary = resolve(resourceDir, "bin/atlas-core-host");
mkdirSync(dirname(packagedBinary), { recursive: true });
cpSync(binary, packagedBinary);
chmodSync(packagedBinary, 0o755);

const engineSource = resolve(root, "services/engine/atlas_engine");
const engineTarget = resolve(resourceDir, "engine/atlas_engine");
mkdirSync(dirname(engineTarget), { recursive: true });
cpSync(engineSource, engineTarget, {
  recursive: true,
  filter: (source) => !source.includes("/__pycache__/") && !source.endsWith(".pyc"),
});

run(process.execPath, [resolve(shellDir, "build.mjs")], shellDir);
