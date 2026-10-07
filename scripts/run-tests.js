/** Swaps the Electron-compiled better-sqlite3 for a system-Node build, runs every test, then restores.
 * Read the exit code, not the tail — piping through tail/grep replaces the status with the pipe's.
 * Tests write to ./data despite USER_DATA_PATH; rm -rf data before trusting a surprising failure. */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "node_modules", "better-sqlite3", "build");
const debugDir = path.join(buildDir, "Debug");
const electronDir = path.join(buildDir, "Debug.electron");
const releaseDir = path.join(buildDir, "Release");

const tests = [
  "tests/dbAdapter.test.js",
  "tests/accounts.test.js",
  "tests/docs.test.js",
  "tests/graph.test.js",
  "tests/performance.test.js",
  "tests/media.test.js",
  "tests/subs.test.js",
  "tests/seal.test.js",
  "tests/doctor.test.js",
  "tests/updates.test.js",
  "tests/vault.test.js",
  "tests/upgrade.test.js",
  "tests/identity.test.js",
  "tests/tags.test.js",
  "tests/imports.test.js",
  "tests/clips.test.js",
  "tests/fsrs.test.js",
  "tests/fsrs.api.test.js",
  "tests/cardHealth.test.js",
  "tests/perUserSrs.test.js",
  "tests/readProgress.test.js",
  "tests/conflicts.test.js",
  "tests/sequencing.test.js",
  "tests/safeFetch.test.js",
  "tests/cardRemovalBudget.test.js",
  "tests/httpErrors.test.js",
  "tests/capabilities.test.js",
  "tests/connection.test.js",
  "tests/translations.test.js",
  "tests/ui.trainer.test.js",
  "tests/ui.graph.test.js",
  "tests/ui.seal.test.js",
  "tests/ui.shell.test.js",
  "tests/ui.flashcards.test.js",
  "tests/ui.documents.test.js",
  "tests/ui.reports.test.js",
  "tests/ui.config.test.js",
  "tests/stats.test.js",
  "tests/diary.test.js",
  "tests/mcpReader.test.js",
  "tests/server.test.js",
  "tests/api/api.test.js",
  "tests/mcp.test.js",
];

function restore() {
  if (fs.existsSync(electronDir)) {
    if (fs.existsSync(debugDir))
      fs.rmSync(debugDir, { recursive: true, force: true });
    fs.renameSync(electronDir, debugDir);
  }
  if (fs.existsSync(releaseDir))
    fs.rmSync(releaseDir, { recursive: true, force: true });
}

// Hide Electron binary
if (fs.existsSync(debugDir)) fs.renameSync(debugDir, electronDir);

// Build for system Node
console.log("Building better-sqlite3 for system Node...");
try {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit", cwd: root });
} catch {
  restore();
  process.exit(1);
}

// Run tests
let failed = false;
for (const testFile of tests) {
  const fullPath = path.join(root, testFile);
  if (!fs.existsSync(fullPath)) continue;
  console.log(`\n--- ${testFile} ---`);
  const result = spawnSync(process.execPath, ["--test", fullPath], {
    stdio: "inherit",
    cwd: root,
  });
  if (result.status !== 0) failed = true;
}

// Restore Electron binary
console.log("\nRestoring Electron build...");
restore();

process.exit(failed ? 1 : 0);
