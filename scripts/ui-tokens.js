#!/usr/bin/env node
/**
 * Size-token migration for src/ui CSS.
 *
 * Walks every declaration in every stylesheet except index.css and replaces px
 * literals, durations, easings, black scrims/shadows and stale var() fallbacks
 * with the tokens from ui-token-rules.js. Anything it cannot decide mechanically
 * (z-index, colours, layout widths off the ladder, multi-layer shadows, line
 * heights) is left alone and listed by --report for hand mapping.
 *
 * Usage:
 *   node scripts/ui-tokens.js --report          what would change, what is left
 *   node scripts/ui-tokens.js --apply           rewrite in place (EOL preserved)
 *   node scripts/ui-tokens.js --apply <files>   same, restricted to these files
 */

import path from "node:path";
import postcss from "postcss";
import {
  LADDERS,
  EASINGS,
  snap,
  familyOf,
  literalAllowed,
  declaredTokens,
  cssFiles,
  readEol,
  writeEol,
  root,
} from "./ui-token-rules.js";

const declared = declaredTokens();
const PX = /(-?)(\d*\.?\d+)px\b/g;
const DUR = /(\d*\.?\d+)(ms|s)\b/g;

const isIconSelector = (rule) =>
  /svg|icon|ico\b|glyph|dot\b|spinner|swatch|check\b|caret|chev/i.test(
    rule.selector || "",
  );

function snapPx(family, n) {
  if (n === 0) return null;
  const ladder = LADDERS[family];
  if (!ladder) return null;
  return snap(ladder, n)[1];
}

function rewriteSize(prop, value, rule, report) {
  const family = familyOf(prop);
  let changed = value;

  if (family === "space" || family === "text" || family === "radius") {
    changed = value.replace(PX, (m, neg, num) => {
      const n = parseFloat(num);
      if (n === 0) return m;
      if (family === "radius" && n >= 99) return "var(--radius-pill)";
      const token = snapPx(family, n);
      return neg ? `calc(var(${token}) * -1)` : `var(${token})`;
    });
  } else if (family === "size") {
    changed = value.replace(PX, (m, neg, num) => {
      const n = parseFloat(num);
      if (n <= 2 || neg) return m;
      if (n <= 12) return `var(${snapPx("space", n)})`;
      if (n <= 64)
        return `var(${snapPx(isIconSelector(rule) ? "icon" : "control", n)})`;
      return `var(${snap(LADDERS.width, n)[1]})`;
    });
  } else if (family === "duration") {
    const isAnimation = /^animation/.test(prop);
    changed = value.replace(DUR, (m, num, unit) => {
      const ms = unit === "s" ? parseFloat(num) * 1000 : parseFloat(num);
      if (isAnimation && ms >= 400) return m;
      return `var(${snap(LADDERS.duration, ms)[1]})`;
    });
    for (const [re, token] of EASINGS) changed = changed.replace(re, token);
  } else if (family === "easing") {
    for (const [re, token] of EASINGS) changed = changed.replace(re, token);
  } else if (family === "shadow") {
    const single = value.trim();
    const ring = single.match(/^0\s+0\s+0\s+(\d*\.?\d+)px\s+(.+)$/);
    const allBlack =
      !/inset|9999px|var\(/.test(single) &&
      /rgba?\(/.test(single) &&
      [...single.matchAll(/rgba?\([^)]*\)/g)].every((m) =>
        /^rgba?\(\s*0\s*,?\s*0\s*,?\s*0\s*[,/]/.test(m[0]),
      );
    if (ring && /accent/.test(ring[2])) changed = "var(--shadow-focus)";
    else if (allBlack) {
      const alphas = [...single.matchAll(/[,/]\s*(0?\.\d+)\s*\)/g)].map((m) =>
        parseFloat(m[1]),
      );
      changed =
        Math.max(...alphas) <= 0.12
          ? "var(--shadow-sm)"
          : "var(--shadow-float)";
    } else if (
      /rgba?\(|#[0-9a-f]{3,8}\b/i.test(single) &&
      !/^var\(/.test(single)
    ) {
      report.push({
        kind: "shadow-literal",
        file: rule.source.input.file,
        line: rule.source.start.line,
        prop,
        value,
        selector: rule.selector,
      });
    }
  }

  if (/^background(-color)?$/.test(prop)) {
    changed = changed
      .replace(
        /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*(0?\.[3-6]\d*)\s*\)/g,
        "var(--color-scrim)",
      )
      .replace(
        /rgb\(\s*0\s+0\s+0\s*\/\s*(0?\.[3-6]\d*|[3-6]\d%)\s*\)/g,
        "var(--color-scrim)",
      );
  }

  changed = changed.replace(
    /var\((--[\w-]+)\s*,\s*[^()]*(?:\([^()]*\))?[^()]*\)/g,
    (m, name) => (declared.has(name) ? `var(${name})` : m),
  );
  changed = changed
    .replace(/var\(--dur-med\)/g, "var(--dur-base)")
    .replace(/var\(--color-hl-pink\)/g, "var(--color-hl-4)");

  return changed;
}

function run(mode, only) {
  const files = only.length ? only.map((f) => path.resolve(f)) : cssFiles();
  const report = [];
  let touched = 0;
  const counts = {};

  for (const file of files) {
    const { text, crlf } = readEol(file);
    const rootNode = postcss.parse(text, { from: file });
    let dirty = false;

    rootNode.walkDecls((decl) => {
      const rule = decl.parent;
      if (!rule || rule.type !== "rule") return;
      if (decl.prop.startsWith("--")) return;
      const before = decl.value;
      const after = rewriteSize(decl.prop, before, rule, report);
      if (after !== before) {
        counts[decl.prop] = (counts[decl.prop] || 0) + 1;
        if (mode === "--apply") {
          decl.value = after;
          dirty = true;
        }
      }
      const family = familyOf(decl.prop);
      if (family === "z" && !/^var\(/.test(after))
        report.push({
          kind: "z-index",
          file,
          line: decl.source.start.line,
          prop: decl.prop,
          value: after,
          selector: rule.selector,
        });
      if (
        /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(after) &&
        !/^box-shadow$/.test(decl.prop)
      ) {
        report.push({
          kind: "color",
          file,
          line: decl.source.start.line,
          prop: decl.prop,
          value: after,
          selector: rule.selector,
        });
      }
      if (
        PX.test(after) &&
        !literalAllowed(decl.prop, after) &&
        family !== "size" &&
        family !== "space" &&
        family !== "text" &&
        family !== "radius"
      ) {
        report.push({
          kind: "px-other",
          file,
          line: decl.source.start.line,
          prop: decl.prop,
          value: after,
          selector: rule.selector,
        });
      }
      PX.lastIndex = 0;
    });

    if (dirty) {
      writeEol(file, rootNode.toString(), crlf);
      touched++;
    }
  }

  const rel = (f) => path.relative(root, f).replace(/\\/g, "/");
  if (mode === "--report") {
    console.log("# Would rewrite (declarations by property)");
    for (const [p, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
      console.log(`  ${p}: ${n}`);
    console.log(`\n# Left for hand mapping (${report.length})`);
    const byKind = {};
    for (const r of report) (byKind[r.kind] ||= []).push(r);
    for (const [kind, items] of Object.entries(byKind)) {
      console.log(`\n## ${kind} (${items.length})`);
      for (const r of items)
        console.log(
          `  ${rel(r.file)}:${r.line}  ${r.selector.split("\n")[0].slice(0, 60)}  { ${r.prop}: ${r.value} }`,
        );
    }
  } else {
    console.log(
      `rewrote ${touched} file(s); ${report.length} item(s) left for hand mapping (run --report)`,
    );
  }
}

const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith("--")) || "--report";
run(
  mode,
  argv.filter((a) => !a.startsWith("--")),
);
