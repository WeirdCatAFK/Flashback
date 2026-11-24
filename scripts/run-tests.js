import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "node_modules", "better-sqlite3", "build");
const debugDir = path.join(buildDir, "Debug");
const electronDir = path.join(buildDir, "Debug.electron");
const releaseDir = path.join(buildDir, "Release");

const tiers = process.argv.slice(2);
if (tiers.length === 0) {
  console.error("usage: node scripts/run-tests.js <tier>...  (unit, integration, legacy, system)");
  process.exit(2);
}
const tests = tiers.flatMap((tier) =>
  fs.readdirSync(path.join(root, "tests", tier), { recursive: true })
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => path.join("tests", tier, file)),
);

function restore() {
  if (fs.existsSync(electronDir)) {
    if (fs.existsSync(debugDir))
      fs.rmSync(debugDir, { recursive: true, force: true });
    fs.renameSync(electronDir, debugDir);
  }
  if (fs.existsSync(releaseDir))
    fs.rmSync(releaseDir, { recursive: true, force: true });
}

if (fs.existsSync(debugDir)) fs.renameSync(debugDir, electronDir);

console.log("Building better-sqlite3 for system Node...");
try {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit", cwd: root });
} catch {
  restore();
  process.exit(1);
}

fs.rmSync(path.join(root, "test-data"), { recursive: true, force: true });

let failed = false;
for (const testFile of tests) {
  const fullPath = path.join(root, testFile);
  console.log(`\n--- ${testFile} ---`);
  const result = spawnSync(process.execPath, ["--test", fullPath], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) failed = true;
}

console.log("\nRestoring Electron build...");
restore();

process.exit(failed ? 1 : 0);
