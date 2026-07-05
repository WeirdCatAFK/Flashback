#!/usr/bin/env node
// scripts/release.js — cut an updater-compatible release.
//
//   npm run release            # patch bump (0.1.0 -> 0.1.1)
//   npm run release -- minor   # minor bump (0.1.0 -> 0.2.0)
//   npm run release -- major   # major bump
//   npm run release -- 1.4.2   # explicit version
//
// Steps: verify a clean tree, bump package.json, commit, create an annotated
// `vX.Y.Z` tag, and push both. Pushing the tag triggers .github/workflows/release.yml,
// which builds the installers + update metadata (latest.yml / latest-linux.yml) and
// uploads them to a DRAFT GitHub Release. Review the draft, then click Publish —
// electron-updater ignores drafts and prereleases.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString().trim();
const runLoud = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // explicit version
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${kind}" (use major|minor|patch or an explicit x.y.z)`);
}

// Refuse to release from a dirty tree — the tag must point at a known-good commit.
if (run('git status --porcelain')) {
  console.error('✗ Working tree is not clean. Commit or stash your changes first.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bump(pkg.version, process.argv[2] || 'patch');
const tag = `v${next}`;

// Guard against re-releasing an existing version.
const tags = run('git tag').split('\n');
if (tags.includes(tag)) {
  console.error(`✗ Tag ${tag} already exists.`);
  process.exit(1);
}

console.log(`→ ${pkg.version} → ${next}`);

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

runLoud(`git add package.json`);
runLoud(`git commit -m "Release ${tag}"`);
runLoud(`git tag -a ${tag} -m "Release ${tag}"`);
runLoud(`git push origin HEAD`);
runLoud(`git push origin ${tag}`);

console.log(`\n✓ Pushed ${tag}. GitHub Actions is building the release.`);
console.log(`  Watch: https://github.com/WeirdCatAFK/Flashback/actions`);
console.log(`  When done, publish the draft: https://github.com/WeirdCatAFK/Flashback/releases`);
