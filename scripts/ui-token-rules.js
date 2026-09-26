/**
 * Shared vocabulary for the size-token migration (ui-tokens.js) and its guard
 * (check-tokens.js). One table, two consumers, so the guard cannot disagree with
 * the migration about what a literal is allowed to be.
 *
 * Snapping rule: nearest step on the ladder; a tie rounds DOWN, so the UI keeps
 * the density it has today rather than drifting looser.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const UI_DIR = path.join(root, "src/ui");
export const INDEX_CSS = path.join(UI_DIR, "index.css");

export const LADDERS = {
  space: [
    [2, "--space-0-5"],
    [4, "--space-1"],
    [8, "--space-2"],
    [12, "--space-3"],
    [16, "--space-4"],
    [20, "--space-5"],
    [24, "--space-6"],
    [32, "--space-8"],
    [40, "--space-10"],
    [48, "--space-12"],
    [64, "--space-16"],
  ],
  text: [
    [11, "--text-xs"],
    [12, "--text-sm"],
    [14, "--text-base"],
    [16, "--text-md"],
    [20, "--text-lg"],
    [28, "--text-xl"],
    [40, "--text-2xl"],
  ],
  radius: [
    [4, "--radius-sm"],
    [6, "--radius-md"],
    [10, "--radius-lg"],
  ],
  control: [
    [20, "--control-xs"],
    [24, "--control-sm"],
    [28, "--control-md"],
    [32, "--control-lg"],
    [36, "--control-xl"],
    [40, "--control-2xl"],
    [48, "--control-bar"],
  ],
  icon: [
    [14, "--icon-sm"],
    [16, "--icon-md"],
    [20, "--icon-lg"],
    [24, "--icon-xl"],
  ],
  width: [
    [80, "--size-xs"],
    [120, "--size-sm"],
    [160, "--size-md"],
    [220, "--size-lg"],
    [280, "--size-xl"],
    [340, "--size-2xl"],
    [420, "--size-3xl"],
    [480, "--size-4xl"],
    [560, "--size-5xl"],
    [640, "--size-6xl"],
    [760, "--size-7xl"],
    [960, "--size-8xl"],
    [1240, "--size-9xl"],
  ],
  duration: [
    [120, "--dur-fast"],
    [200, "--dur-base"],
    [300, "--dur-slow"],
  ],
};

/** Nearest ladder step; ties round down. */
export function snap(ladder, n) {
  let best = ladder[0];
  for (const step of ladder) {
    const d = Math.abs(step[0] - n);
    const bd = Math.abs(best[0] - n);
    if (d < bd || (d === bd && step[0] < best[0])) best = step;
  }
  return best;
}

/** Which ladder a property's px literals belong to. */
export function familyOf(prop) {
  const p = prop.toLowerCase();
  if (p === "font-size") return "text";
  if (
    /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|scroll-padding|scroll-margin)/.test(
      p,
    )
  )
    return "space";
  if (/radius$/.test(p)) return "radius";
  if (
    /^(width|height|min-width|min-height|max-width|max-height|flex-basis|flex|block-size|inline-size)$/.test(
      p,
    )
  )
    return "size";
  if (/^(transition|animation)(-duration)?$/.test(p)) return "duration";
  if (p === "transition-timing-function" || p === "animation-timing-function")
    return "easing";
  if (p === "z-index") return "z";
  if (p === "box-shadow") return "shadow";
  return null;
}

/**
 * Properties in which a small px literal is a hairline or a motion offset, not a
 * size on the scale, and stays literal.
 */
export function literalAllowed(prop, value) {
  const p = prop.toLowerCase().replace(/^-(webkit|moz|ms)-/, "");
  if (/^(border|outline)/.test(p)) return true;
  if (/^(text-shadow)/.test(p)) return true;
  if (
    familyOf(p) === "size" &&
    [...value.matchAll(/(-?\d*\.?\d+)px\b/g)].every(
      (m) => Math.abs(parseFloat(m[1])) <= 2,
    )
  )
    return true;
  if (
    /^(transform|translate|rotate|scale|background|stroke|letter-spacing|text-underline-offset|text-indent|outline-offset|word-spacing|perspective|backdrop-filter|filter|mask|clip-path|object-position)/.test(
      p,
    )
  )
    return true;
  if (p === "box-shadow") return true;
  if (p === "line-height") return false;
  if (/^animation/.test(p) && /(\d+)ms|(\d*\.\d+|\d+)s\b/.test(value))
    return true;
  return false;
}

export const EASINGS = [
  [
    /cubic-bezier\(\s*0?\.2\s*,\s*0?\.[78]\s*,\s*0?\.[23]\s*,\s*1\s*\)/g,
    "var(--ease-in-out)",
  ],
  [
    /cubic-bezier\(\s*0?\.16\s*,\s*1\s*,\s*0?\.3\s*,\s*1\s*\)/g,
    "var(--ease-out)",
  ],
  [/(?<![\w-])ease-out(?![\w-])/g, "var(--ease-out)"],
];

/** Custom properties set from JS at runtime, never declared in a stylesheet. */
export const RUNTIME_VARS = new Set([
  "--ui-zoom",
  "--i",
  "--dot-color",
  "--total-scale-factor",
  "--scale-round-x",
  "--scale-round-y",
  "--scale-factor",
  "--font-height",
  "--min-font-size",
  "--text-scale-factor",
  "--scale-x",
  "--rotate",
  "--user-unit",
  "--pct",
  "--w",
  "--h",
  "--x",
  "--y",
  "--fill",
  "--hl",
  "--sleeve",
]);

/** Every `--name` declared anywhere in index.css. */
export function declaredTokens() {
  const css = fs.readFileSync(INDEX_CSS, "utf8");
  const out = new Set();
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/** Recursively list .css files under src/ui except index.css. */
export function cssFiles(dir = UI_DIR, out = []) {
  for (const e of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) cssFiles(full, out);
    else if (e.name.endsWith(".css") && full !== INDEX_CSS) out.push(full);
  }
  return out;
}

export function readEol(file) {
  const raw = fs.readFileSync(file, "utf8");
  return { text: raw.replace(/\r\n/g, "\n"), crlf: raw.includes("\r\n") };
}

export function writeEol(file, text, crlf) {
  fs.writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text);
}
