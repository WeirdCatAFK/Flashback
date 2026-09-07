#!/usr/bin/env node
// scripts/release.js — cut an updater-compatible release.
//
//   npm run release            # patch bump (0.1.0 -> 0.1.1)
//   npm run release -- minor   # minor bump (0.1.0 -> 0.2.0)
//   npm run release -- major   # major bump
//   npm run release -- 1.4.2   # explicit version
//   npm run release -- --dry-run [kind]   # run the checks, print the plan, change nothing
//
// Steps: verify a clean tree, bump package.json, commit, create an annotated
// `vX.Y.Z` tag, and push both. Pushing the tag triggers .github/workflows/release.yml,
// which builds the installers + update metadata (latest.yml / latest-linux.yml) and
// uploads them to a DRAFT GitHub Release. Review the draft, then click Publish —
// electron-updater ignores drafts and prereleases.
//
// `--dry-run` exists because of the ordering problem this script has always had: the tag
// is what triggers the build, so the build's verdict arrives AFTER the tag is public. The
// Prerelease workflow (.github/workflows/prerelease.yml) closes that by running everything
// release.yml runs — installers, server image, zips, the suite — on an untagged commit,
// and it calls THIS script with --dry-run for the version math and the tag guard. One
// implementation, so CI cannot compute a different next version than the developer does.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
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

// Flags are filtered out so the bump kind stays positional, exactly as it was: the first
// non-flag argument, or "patch". `npm run release -- --dry-run minor` and
// `npm run release -- minor` therefore agree on what "minor" means.
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kind = args.find((a) => !a.startsWith('-')) || 'patch';

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

let next;
try {
  next = bump(pkg.version, kind);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
const tag = `v${next}`;

// The checks, collected rather than thrown one at a time. A dry run is asking "is this
// releasable", and answering with only the first of two problems means two round trips
// through a workflow that builds three installers.
const problems = [];

// Refuse to release from a dirty tree — the tag must point at a known-good commit.
if (run('git status --porcelain')) {
  problems.push('Working tree is not clean. Commit or stash your changes first.');
}

const allTags = run('git tag').split('\n');

// Guard against re-releasing an existing version.
if (allTags.includes(tag)) {
  problems.push(`Tag ${tag} already exists.`);
}

// Guard against releasing BACKWARDS, which the check above cannot see: it only asks whether
// this exact tag exists, so a package.json that has fallen behind the highest tag produces a
// brand-new tag for an OLD version and passes.
//
// That is not hypothetical here. v0.4.3 is a tag on a commit that contains nothing but its
// own version bump, and that commit never landed on main — so main's package.json still says
// 0.4.1 while v0.4.3 is published. A default `npm run release` from that state computes
// 0.4.2, finds no such tag, and cuts a release older than the one already out. Nothing
// downstream catches it either: release.yml compares the tag to package.json, and those two
// agree perfectly.
//
// It matters because electron-updater keys everything off the version in latest.yml. A
// release below the current one is invisible to everybody already on the newer build, and
// leaves the Releases page out of order.
const semver = (v) => v.replace(/^v/, '').split('.').map(Number);
const newer = (a, b) => {                       // a > b
  const [x, y, z] = semver(a), [p, q, r] = semver(b);
  return x !== p ? x > p : y !== q ? y > q : z > r;
};
const released = allTags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
if (released.length) {
  const highest = released.reduce((max, t) => (newer(t, max) ? t : max));
  if (highest !== tag && !newer(tag, highest)) {
    problems.push(
      `${tag} is not newer than ${highest}, the highest tag already released. ` +
      `package.json (${pkg.version}) has fallen behind — pass an explicit version above ` +
      `${highest.replace(/^v/, '')}, or delete the stray tag if it was a mistake.`
    );
  }
}

if (dryRun) {
  console.log('Release plan');
  console.log(`  current : ${pkg.version}`);
  console.log(`  next    : ${next}${next === pkg.version ? '  (unchanged — would tag HEAD)' : ''}`);
  console.log(`  tag     : ${tag}`);

  // Advisory, never fatal. CHANGELOG.md is the release body someone pastes into the draft,
  // so an entry that does not exist yet is worth saying out loud at the point the version
  // is decided — but it is prose, and prose is not a reason to block a build.
  try {
    if (!readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes(next)) {
      console.log(`\n! CHANGELOG.md does not mention ${next} yet — write the release body before publishing the draft.`);
    }
  } catch {
    console.log('\n! CHANGELOG.md could not be read.');
  }

  if (problems.length) {
    console.error('\n✗ Not releasable:');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
  }

  // Hand the computed version to the rest of the workflow, so the summary can name the
  // exact command to run next rather than making someone re-derive it.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${next}\ntag=${tag}\n`);
  }

  console.log('\n✓ Release checks passed. Nothing was changed.');
  process.exit(0);
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

// If the requested version already matches package.json (e.g. the very first
// release at the current version), there's nothing to bump — just tag HEAD.
if (next === pkg.version) {
  console.log(`→ version already ${next}; tagging current commit`);
} else {
  console.log(`→ ${pkg.version} → ${next}`);
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  runLoud(`git add package.json`);
  runLoud(`git commit -m "Release ${tag}"`);
}

runLoud(`git tag -a ${tag} -m "Release ${tag}"`);
runLoud(`git push origin HEAD`);
runLoud(`git push origin ${tag}`);

console.log(`\n✓ Pushed ${tag}. GitHub Actions is building the release.`);
console.log(`  Watch: https://github.com/WeirdCatAFK/Flashback/actions`);
console.log(`  When done, publish the draft: https://github.com/WeirdCatAFK/Flashback/releases`);
