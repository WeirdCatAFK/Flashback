#!/usr/bin/env node
/**
 * Pass the bump after npm's argument separator: patch, minor, major or an exact version.
 * The default is patch. The --dry-run flag prints the plan and changes nothing.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString().trim();
const runLoud = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown bump "${kind}" (use major|minor|patch or an explicit x.y.z)`);
}

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

const problems = [];

if (run('git status --porcelain')) {
  problems.push('Working tree is not clean. Commit or stash your changes first.');
}

const allTags = run('git tag').split('\n');

if (allTags.includes(tag)) {
  problems.push(`Tag ${tag} already exists.`);
}

const semver = (v) => v.replace(/^v/, '').split('.').map(Number);
const newer = (a, b) => {
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

  console.log(`\n  Write the release body in the GitHub Release draft before publishing.`);

  if (problems.length) {
    console.error('\n✗ Not releasable:');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
  }

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
