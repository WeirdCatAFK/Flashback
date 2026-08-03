#!/usr/bin/env node
/**
 * Theme contrast regression check.
 *
 * Parses the real token blocks out of src/ui/index.css and asserts every
 * text/background pair the UI actually renders. The pairs below are not a
 * generic accessibility sweep — each one mirrors a specific rule in the CSS,
 * noted alongside it, so a failure points at the declaration that broke.
 *
 * Run: node scripts/check-contrast.js       (exits non-zero on any failure)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = path.join(root, 'src/ui/index.css');

// ── colour maths ────────────────────────────────────────────────────────────

const hex2rgb = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

const luminance = ([r, g, b]) => {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/** Approximates CSS `color-mix(in srgb, a p%, b)`. */
const mix = (a, b, p) => a.map((c, i) => c * (p / 100) + b[i] * (1 - p / 100));

// ── token parsing ───────────────────────────────────────────────────────────

function parseThemes(css) {
  const themes = {};
  const blockRe = /(?:^|\n)((?::root,\s*)?\[data-theme="([^"]+)"\]|:root)\s*\{([\s\S]*?)\n\}/g;
  let block;
  while ((block = blockRe.exec(css))) {
    const name = block[2];
    if (!name) continue; // the theme-invariant :root scale block
    const vars = {};
    const varRe = /(--color-[\w-]+):\s*([^;]+);/g;
    let v;
    while ((v = varRe.exec(block[3]))) vars[v[1]] = v[2].trim();
    themes[name] = vars;
  }
  return themes;
}

// ── OKLab, for the graph palette's perceptual separation checks ─────────────

function oklab([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  [r, g, b] = [f(r), f(g), f(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Machado et al. CVD simulation matrices (severity 1.0), applied in linear sRGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

function simulate(rgb, kind) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const g = (c) => { c = Math.max(0, Math.min(1, c)); return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255; };
  const [r0, g0, b0] = rgb.map(f);
  const M = CVD[kind];
  return [0, 1, 2].map((i) => g(M[i][0] * r0 + M[i][1] * g0 + M[i][2] * b0));
}

/** Perceptual distance in OKLab x100; `kind` null = normal vision. */
function deltaE(a, b, kind) {
  const [x, y] = [oklab(kind ? simulate(a, kind) : a), oklab(kind ? simulate(b, kind) : b)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Resolves a token to rgb, following `var(--x)` indirection. */
function resolve(vars, token, depth = 0) {
  const raw = vars[token];
  if (!raw || depth > 5) return null;
  const indirect = raw.match(/^var\((--[\w-]+)\)$/);
  if (indirect) return resolve(vars, indirect[1], depth + 1);
  return /^#[0-9a-fA-F]{3,8}$/.test(raw) ? hex2rgb(raw) : null;
}

// ── the contract ────────────────────────────────────────────────────────────
// [foreground, background, minRatio, what renders this pair]

const TEXT_PAIRS = [
  ['--color-fg-primary',   '--color-bg-base',      4.5, 'body text on the window'],
  ['--color-fg-primary',   '--color-bg-surface',   4.5, 'body text on a panel'],
  ['--color-fg-primary',   '--color-bg-sidebar',   4.5, 'text on the activity bar'],
  ['--color-fg-primary',   '--color-bg-reader',    4.5, 'document text (Renderer.css)'],
  ['--color-fg-primary',   '--color-bg-hover',     4.5, 'text on a hovered row'],
  ['--color-fg-secondary', '--color-bg-base',      4.5, 'muted text on the window'],
  ['--color-fg-secondary', '--color-bg-surface',   4.5, 'muted text on a panel'],
  ['--color-fg-secondary', '--color-bg-sidebar',   4.5, 'muted text on the activity bar'],
  ['--color-fg-icon',      '--color-bg-sidebar',   3,   'inactive icons on the activity bar'],
  ['--color-on-accent',    '--color-accent',       4.5, 'label on a primary button'],
  ['--color-accent',       '--color-bg-base',      4.5, 'a { color: accent } on the window'],
  ['--color-accent',       '--color-bg-surface',   4.5, 'a { color: accent } on a panel'],
  ['--color-accent',       '--color-accent-subtle',4.5, 'accent text on an accent tint'],
  ['--color-danger',       '--color-bg-surface',   4.5, 'error text on a panel'],
  ['--color-danger',       '--color-bg-base',      4.5, 'error text on the window'],
  ['--color-border-strong','--color-bg-surface',   3,   'input border on a panel'],
  ['--color-border-strong','--color-bg-base',      3,   'input border on the window'],
];

const GRADES = ['again', 'hard', 'good', 'easy'];

function checkTheme(name, vars, report) {
  const fail = (msg) => report.push(`  ${name}: ${msg}`);
  const get = (t) => resolve(vars, t);

  for (const [fgT, bgT, min, what] of TEXT_PAIRS) {
    const fg = get(fgT);
    const bg = get(bgT);
    if (!fg || !bg) { fail(`missing token in pair ${fgT} / ${bgT}`); continue; }
    const c = contrast(fg, bg);
    if (c < min) fail(`${c.toFixed(2)} < ${min} — ${what} (${fgT} on ${bgT})`);
  }

  // Grade swatches play three roles; all three have to hold at once.
  const surface = get('--color-bg-surface');
  const onReview = get('--color-on-review');
  for (const g of GRADES) {
    const sw = get(`--color-review-${g}`);
    if (!sw || !surface || !onReview) { fail(`missing --color-review-${g} / --color-on-review`); continue; }
    const label = contrast(onReview, sw);
    const asText = contrast(sw, surface);
    const onTint = contrast(sw, mix(sw, surface, 8));
    if (label < 4.5)  fail(`${label.toFixed(2)} < 4.5 — "${g}" label on its fill (.trainer-grade)`);
    if (asText < 4.5) fail(`${asText.toFixed(2)} < 4.5 — "${g}" as text on a panel (.sum--${g} b)`);
    if (onTint < 4.5) fail(`${onTint.toFixed(2)} < 4.5 — "${g}" verdict text on its 8% tint`);
  }

  // Highlights are painted behind document text.
  const fg = get('--color-fg-primary');
  for (let i = 1; i <= 4; i++) {
    const hl = get(`--color-hl-${i}`);
    if (!hl || !fg) { fail(`missing --color-hl-${i}`); continue; }
    const c = contrast(fg, hl);
    if (c < 4.5) fail(`${c.toFixed(2)} < 4.5 — document text on highlight ${i}`);
  }

  // Graph nodes are bare dots on the canvas: each must be visible against it,
  // and every PAIR must be separable or you cannot read the graph at a glance.
  const canvas = get('--color-bg-base');
  const GRAPH = ['document', 'folder', 'flashcard', 'tag', 'deck'];
  const nodes = GRAPH.map((n) => [n, get(`--color-graph-${n}`)]);
  for (const [n, c] of nodes) {
    if (!c) { fail(`missing --color-graph-${n}`); continue; }
    const ct = contrast(c, canvas);
    if (ct < 3) fail(`${ct.toFixed(2)} < 3 — graph "${n}" node against the canvas`);
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [na, ca] = nodes[i];
      const [nb, cb] = nodes[j];
      if (!ca || !cb) continue;
      const normal = deltaE(ca, cb, null);
      const cvd = Math.min(...Object.keys(CVD).map((k) => deltaE(ca, cb, k)));
      if (normal < 15) fail(`${normal.toFixed(1)} < 15 — graph nodes "${na}"/"${nb}" too alike (normal vision)`);
      if (cvd < 8) fail(`${cvd.toFixed(1)} < 8 — graph nodes "${na}"/"${nb}" too alike under colour-blindness`);
    }
  }
  // The link relations that aren't node colours still have to show on the canvas.
  for (const t of ['link', 'disconnect', 'inherit']) {
    const c = get(`--color-graph-${t}`);
    if (!c) { fail(`missing --color-graph-${t}`); continue; }
    const ct = contrast(c, canvas);
    if (ct < 3) fail(`${ct.toFixed(2)} < 3 — graph "${t}" link against the canvas`);
  }
  // Resting links carry no identity, so they only need to read as structure —
  // visible, but quieter than any node so they never compete with one.
  const edge = get('--color-graph-edge');
  if (!edge) fail('missing --color-graph-edge');
  else {
    const ct = contrast(edge, canvas);
    if (ct < 1.8) fail(`${ct.toFixed(2)} < 1.8 — graph resting links invisible on the canvas`);
    const loudest = Math.min(...nodes.filter(([, c]) => c).map(([, c]) => contrast(c, canvas)));
    if (ct > loudest) {
      fail(`resting links (${ct.toFixed(2)}) out-contrast the quietest node (${loudest.toFixed(2)}) — structure should recede`);
    }
  }

  // A hover state nobody can see is not a hover state.
  const hover = get('--color-bg-hover');
  const base = get('--color-bg-base');
  if (hover && base && surface) {
    const vsSurface = contrast(hover, surface);
    const vsBase = contrast(hover, base);
    if (vsSurface < 1.12 || vsBase < 1.12) {
      fail(`hover barely differs from its backdrop (panel ${vsSurface.toFixed(3)}, window ${vsBase.toFixed(3)}, want >= 1.12)`);
    }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const themes = parseThemes(fs.readFileSync(CSS, 'utf8'));
const names = Object.keys(themes);

if (names.length === 0) {
  console.error('No [data-theme] blocks found in src/ui/index.css — did the file move?');
  process.exit(1);
}

const failures = [];
for (const name of names) checkTheme(name, themes[name], failures);

if (failures.length) {
  console.error(`Theme contrast check failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n`);
  console.error(failures.join('\n'));
  console.error('\nSee the token-role note at the top of the theme block in src/ui/index.css.');
  process.exit(1);
}

console.log(`Theme contrast check passed — ${names.length} themes: ${names.join(', ')}`);
