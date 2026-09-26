#!/usr/bin/env node
/**
 * Translation key-set invariant for the src/ui revision.
 *
 * `translations:check` is red at baseline (untranslated keys), so the useful
 * invariant during a refactor is narrower: the SET of extracted keys must not
 * change, and no t()/tp() call may lose its literal argument.
 *
 *   node scripts/ui-keyset.js --snapshot <file>   write the sorted key list
 *   node scripts/ui-keyset.js --check <file>      exit 1 on any added/removed key or violation
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTree } from "./translations-extract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, file] = process.argv.slice(2);
const { keys, violations } = extractTree(path.join(root, "src/ui"), {
  exclude: ["translations/"],
});
const current = [...keys.keys()].sort();

if (mode === "--snapshot") {
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  console.log(`snapshot: ${current.length} keys`);
} else if (mode === "--check") {
  const base = new Set(JSON.parse(fs.readFileSync(file, "utf8")));
  const cur = new Set(current);
  const added = current.filter((k) => !base.has(k));
  const removed = [...base].filter((k) => !cur.has(k));
  for (const v of violations)
    console.error(`violation: ${v.file}:${v.line} ${v.snippet ?? ""}`);
  for (const k of added) console.error(`+ ${k}`);
  for (const k of removed) console.error(`- ${k}`);
  if (violations.length || added.length || removed.length) {
    console.error(
      `✗ key set drifted (+${added.length} / -${removed.length}, ${violations.length} violation(s))`,
    );
    process.exit(1);
  }
  console.log(`✓ key set unchanged (${current.length} keys)`);
} else {
  console.error("usage: --snapshot <file> | --check <file>");
  process.exit(2);
}
