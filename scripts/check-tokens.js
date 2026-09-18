#!/usr/bin/env node
/**
 * Size-token guard for src/ui CSS.
 *
 * Every stylesheet except index.css must express sizes, durations, easings,
 * colours and stacking through the tokens declared in index.css. This walks each
 * declaration and reports:
 *
 *   px        a px literal outside the hairline/offset properties ui-token-rules
 *             allows (border, outline, transform, background-*, …) and not 0
 *   duration  a ms/s literal in a transition (animations >= 400ms may stay literal)
 *   easing    a cubic-bezier() literal
 *   color     a hex / rgb() / hsl() literal
 *   z-index   a z-index that is not var(--z-*)
 *   undefined var(--x) where --x is declared neither in index.css, nor in the
 *             same file, nor set from JS at runtime
 *
 * Exit 1 on any finding. Run: node scripts/check-tokens.js  (npm run check:tokens)
 */

import path from "node:path";
import postcss from "postcss";
import {
  declaredTokens,
  cssFiles,
  readEol,
  literalAllowed,
  RUNTIME_VARS,
  root,
} from "./ui-token-rules.js";

const declared = declaredTokens();
const findings = [];
const rel = (f) => path.relative(root, f).replace(/\\/g, "/");

for (const file of cssFiles()) {
  const { text } = readEol(file);
  const ast = postcss.parse(text, { from: file });
  const local = new Set();
  ast.walkDecls((d) => {
    if (d.prop.startsWith("--")) local.add(d.prop);
  });

  ast.walkDecls((decl) => {
    const { prop, value } = decl;
    const line = decl.source.start.line;
    const where = `${rel(file)}:${line}`;
    const inKeyframes =
      decl.parent?.parent?.type === "atrule" &&
      /keyframes/.test(decl.parent.parent.name);
    const flag = (kind) =>
      findings.push(`${where}  ${kind}  { ${prop}: ${value} }`);

    for (const m of value.matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1];
      if (!declared.has(name) && !local.has(name) && !RUNTIME_VARS.has(name))
        flag("undefined");
    }
    if (prop.startsWith("--")) return;

    const pxs = [...value.matchAll(/(-?\d*\.?\d+)px\b/g)]
      .map((m) => parseFloat(m[1]))
      .filter((n) => n !== 0);
    if (pxs.length && !literalAllowed(prop, value) && !inKeyframes) flag("px");

    if (/^transition/.test(prop) && /\d(ms|s)\b/.test(value)) flag("duration");
    if (/^animation/.test(prop)) {
      for (const m of value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
        const ms = m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
        if (ms < 400) flag("duration");
      }
    }
    if (/cubic-bezier\(/.test(value)) flag("easing");
    if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value) && !inKeyframes)
      flag("color");
    if (
      prop === "z-index" &&
      !/^var\(--z-/.test(value) &&
      value !== "0" &&
      value !== "auto"
    )
      flag("z-index");
  });
}

if (findings.length) {
  console.error(findings.join("\n"));
  console.error(`\n✗ ${findings.length} token violation(s)`);
  process.exit(1);
}
console.log(
  "✓ check-tokens: every size, colour, duration and z-index goes through a token",
);
