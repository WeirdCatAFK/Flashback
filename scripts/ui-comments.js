#!/usr/bin/env node
/**
 * Comment normalization for src/ui — the mechanical half of the pass.
 *
 * Parses each file with acorn (+ acorn-jsx) so strings, regexes and template
 * literals are never mistaken for comments, then classifies every comment:
 *
 *   header     the comment at offset 0             → kept (hand-trimmed later)
 *   directive  eslint-* / @ts-* / global / prettier → kept; a trailing
 *              `eslint-disable-line` becomes `eslint-disable-next-line` above
 *   jsdoc      a JSDoc block immediately above a top-level statement → kept
 *   doc-line   // line(s) immediately above a top-level statement → rewritten
 *              as a JSDoc block (hand-trimmed later)
 *   jsx        a JSX comment container                → removed
 *   body       inside any function                 → removed
 *   trailing   code precedes it on the line         → removed
 *   banner     ── / --- / === section dividers      → removed
 *   loose      any other top-level comment          → removed
 *
 * Every removal is proven code-neutral: the file is re-parsed after the edit and
 * the two ASTs (positions stripped, JSX whitespace normalized) must be deep-equal
 * or the file is left untouched and the run fails.
 *
 * Usage:
 *   node scripts/ui-comments.js --inventory [--out file.md] <paths...>
 *   node scripts/ui-comments.js --apply <paths...>
 *   node scripts/ui-comments.js --verify <paths...>     (HEAD vs working tree)
 *   node scripts/ui-comments.js --residue <paths...>    (top-level comments left)
 *
 * A path may be a file or a directory (walked for .js/.jsx).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Parser } from "acorn";
import jsx from "acorn-jsx";

const JSXParser = Parser.extend(jsx());

const DIRECTIVE_RE =
  /^\s*(eslint|@ts-|global\b|globals\b|exported\b|prettier-ignore|istanbul)/;
const BANNER_RE = /[─═—]{3,}|^\s*[-=]{3,}\s*$|^\s*[-=]{3,}\s.*[-=]{3,}\s*$/;

// ── parsing ─────────────────────────────────────────────────────────────────

function parse(source) {
  const comments = [];
  const ast = JSXParser.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    ranges: true,
    allowHashBang: true,
    onComment: comments,
  });
  return { ast, comments };
}

/** Generic child iteration over an acorn node. */
function* children(node) {
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end")
      continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") yield c;
    } else if (v && typeof v.type === "string") {
      yield v;
    }
  }
}

const FN_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Collect function ranges (with a display name) and empty JSX expression containers. */
function collect(ast) {
  const fns = [];
  const jsxEmpty = [];
  const topLevel = ast.body;

  function nameFor(node, parent, grand) {
    if (node.id?.name) return node.id.name;
    if (parent?.type === "VariableDeclarator" && parent.id?.name)
      return parent.id.name;
    if (parent?.type === "Property" && parent.key?.name) return parent.key.name;
    if (parent?.type === "MethodDefinition" && parent.key?.name)
      return parent.key.name;
    if (parent?.type === "AssignmentExpression" && parent.left?.property?.name)
      return parent.left.property.name;
    if (
      parent?.type === "CallExpression" &&
      grand?.type === "VariableDeclarator"
    )
      return grand.id?.name ?? "(anonymous)";
    return "(anonymous)";
  }

  function visit(node, parent, grand) {
    if (FN_TYPES.has(node.type))
      fns.push({
        start: node.start,
        end: node.end,
        name: nameFor(node, parent, grand),
      });
    if (
      node.type === "JSXExpressionContainer" &&
      node.expression?.type === "JSXEmptyExpression"
    ) {
      jsxEmpty.push({ start: node.start, end: node.end });
    }
    for (const c of children(node)) visit(c, node, parent);
  }
  visit(ast, null, null);
  fns.sort((a, b) => a.start - b.start || b.end - a.end);
  return { fns, jsxEmpty, topLevel };
}

// ── classification ──────────────────────────────────────────────────────────

function lineStartOf(src, pos) {
  const i = src.lastIndexOf("\n", pos - 1);
  return i + 1;
}
function lineEndOf(src, pos) {
  const i = src.indexOf("\n", pos);
  return i === -1 ? src.length : i;
}

function classify(source, { comments }, info) {
  const { fns, jsxEmpty, topLevel } = info;
  const out = [];
  const inJsx = (c) =>
    jsxEmpty.some((j) => c.start >= j.start && c.end <= j.end);
  const enclosing = (c) => {
    let best = null;
    for (const f of fns) if (c.start >= f.start && c.end <= f.end) best = f;
    return best;
  };
  const nextStatementAt = (pos) => {
    for (const s of topLevel) if (s.start >= pos) return s;
    return null;
  };

  // group consecutive `//` lines into one unit
  const units = [];
  for (const c of comments) {
    const prev = units[units.length - 1];
    if (
      c.type === "Line" &&
      prev &&
      prev.type === "Line" &&
      !prev.trailing &&
      !DIRECTIVE_RE.test(c.value) &&
      !DIRECTIVE_RE.test(prev.parts[prev.parts.length - 1].value) &&
      source.slice(prev.end, c.start).trim() === "" &&
      source.slice(prev.end, c.start).split("\n").length === 2 &&
      source.slice(lineStartOf(source, c.start), c.start).trim() === ""
    ) {
      prev.end = c.end;
      prev.value += "\n" + c.value;
      prev.parts.push(c);
      continue;
    }
    const trailing =
      source.slice(lineStartOf(source, c.start), c.start).trim() !== "";
    units.push({
      type: c.type,
      start: c.start,
      end: c.end,
      value: c.value,
      trailing,
      parts: [c],
    });
  }

  const firstUnit = units[0];
  for (const u of units) {
    const text = u.value;
    let kind;
    if (
      u === firstUnit &&
      source
        .slice(0, u.start)
        .trim()
        .replace(/^#!.*$/m, "")
        .trim() === ""
    )
      kind = "header";
    else if (inJsx(u)) kind = "jsx";
    else if (DIRECTIVE_RE.test(text))
      kind =
        u.trailing && /eslint-disable-line/.test(text)
          ? "directive-trailing"
          : "directive";
    else if (u.trailing) kind = "trailing";
    else if (BANNER_RE.test(text)) kind = "banner";
    else if (enclosing(u)) kind = "body";
    else {
      const gap = source.slice(
        u.end,
        nextStatementAt(u.end)?.start ?? source.length,
      );
      const attached =
        gap.trim() === "" &&
        gap.split("\n").length <= 2 &&
        nextStatementAt(u.end);
      if (!attached) kind = "loose";
      else if (u.type === "Block" && text.startsWith("*")) kind = "jsdoc";
      else kind = "doc-line";
    }
    out.push({ ...u, kind, fn: enclosing(u)?.name ?? null });
  }
  return out;
}

// ── rewriting ───────────────────────────────────────────────────────────────

function indentOf(src, pos) {
  const ls = lineStartOf(src, pos);
  return src.slice(ls, pos).match(/^\s*/)[0];
}

function toJsdoc(text, indent) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").replace(/\s+$/, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`.replace(/\s+$/, "")).join("\n")}\n${indent} */`;
}

function rewrite(source, units, info) {
  const edits = [];
  const removeLines = (start, end) => {
    const ls = lineStartOf(source, start);
    let le = lineEndOf(source, end);
    if (
      source.slice(ls, start).trim() === "" &&
      source.slice(end, le).trim() === ""
    ) {
      if (le < source.length) le += 1;
      edits.push({ start: ls, end: le, text: "" });
    } else {
      edits.push({ start, end, text: "" });
    }
  };

  for (const j of info.jsxEmpty) removeLines(j.start, j.end);

  for (const u of units) {
    switch (u.kind) {
      case "jsx":
        break;
      case "body":
      case "banner":
      case "loose":
        removeLines(u.start, u.end);
        break;
      case "trailing": {
        let s = u.start;
        while (s > 0 && (source[s - 1] === " " || source[s - 1] === "\t")) s--;
        edits.push({ start: s, end: u.end, text: "" });
        break;
      }
      case "directive-trailing": {
        let s = u.start;
        while (s > 0 && (source[s - 1] === " " || source[s - 1] === "\t")) s--;
        edits.push({ start: s, end: u.end, text: "" });
        const ls = lineStartOf(source, u.start);
        const indent = indentOf(
          source,
          u.start === ls ? u.start : ls + source.slice(ls).search(/\S/),
        );
        const rule = u.value
          .replace(/eslint-disable-line/, "eslint-disable-next-line")
          .trim();
        edits.push({ start: ls, end: ls, text: `${indent}// ${rule}\n` });
        break;
      }
      case "doc-line": {
        const indent = indentOf(source, u.start);
        const ls = lineStartOf(source, u.start);
        edits.push({ start: ls, end: u.end, text: toJsdoc(u.value, indent) });
        break;
      }
      default:
        break;
    }
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const e of edits)
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out.replace(/\n{3,}/g, "\n\n");
}

// ── verification ────────────────────────────────────────────────────────────

const POS_KEYS = new Set(["start", "end", "loc", "range"]);

function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const key of Object.keys(node)) {
    if (POS_KEYS.has(key)) continue;
    let v = node[key];
    if (key === "children" && Array.isArray(v)) {
      v = v.filter(
        (c) =>
          !(
            c.type === "JSXExpressionContainer" &&
            c.expression?.type === "JSXEmptyExpression"
          ) &&
          !(
            c.type === "JSXText" &&
            /^\s*$/.test(c.value) &&
            c.value.includes("\n")
          ),
      );
    }
    out[key] = normalize(v);
  }
  return out;
}

function astEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

// ── driver ──────────────────────────────────────────────────────────────────

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e), out);
  } else if (/\.jsx?$/.test(p)) out.push(p);
  return out;
}

function readNormalized(file) {
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  return { source: raw.replace(/\r\n/g, "\n"), crlf };
}

function analyze(file) {
  const { source, crlf } = readNormalized(file);
  const parsed = parse(source);
  const info = collect(parsed.ast);
  const units = classify(source, parsed, info);
  return { source, crlf, units, parsed, info };
}

function inventory(files, outPath) {
  const lines = [];
  const REMOVED = new Set(["body", "jsx", "trailing", "banner", "loose"]);
  for (const file of files) {
    const { units } = analyze(file);
    const removed = units.filter((u) => REMOVED.has(u.kind));
    if (!removed.length) continue;
    lines.push(
      `\n## ${path.relative(process.cwd(), file).replace(/\\/g, "/")} (${removed.length})\n`,
    );
    let lastFn;
    for (const u of removed) {
      const fn = u.fn ?? "(module)";
      if (fn !== lastFn) {
        lines.push(`\n### ${fn}\n`);
        lastFn = fn;
      }
      const text = u.value
        .split("\n")
        .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
      lines.push(`- [${u.kind}] ${text}`);
    }
  }
  const md = `# Comment inventory\n${lines.join("\n")}\n`;
  if (outPath) fs.writeFileSync(outPath, md);
  else process.stdout.write(md);
}

function apply(files) {
  let failed = 0;
  for (const file of files) {
    const { source, crlf, units, parsed, info } = analyze(file);
    const next = rewrite(source, units, info);
    if (next === source) continue;
    let after;
    try {
      after = parse(next);
    } catch (err) {
      console.error(`✗ ${file}: rewrite does not parse — ${err.message}`);
      failed++;
      continue;
    }
    if (!astEqual(parsed.ast, after.ast)) {
      console.error(`✗ ${file}: AST changed; file left untouched`);
      failed++;
      continue;
    }
    fs.writeFileSync(file, crlf ? next.replace(/\n/g, "\r\n") : next);
    const removed = units.filter((u) =>
      ["body", "jsx", "trailing", "banner", "loose"].includes(u.kind),
    ).length;
    console.log(
      `✓ ${path.relative(process.cwd(), file)}: ${removed} comment unit(s) removed`,
    );
  }
  return failed;
}

function verify(files) {
  let failed = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    let head;
    try {
      head = execFileSync("git", ["show", `HEAD:${rel}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      console.log(`- ${rel}: not in HEAD, skipped`);
      continue;
    }
    const a = parse(head.replace(/\r\n/g, "\n")).ast;
    const b = parse(readNormalized(file).source).ast;
    if (astEqual(a, b)) console.log(`✓ ${rel}`);
    else {
      console.error(`✗ ${rel}: AST differs from HEAD`);
      failed++;
    }
  }
  return failed;
}

function residue(files) {
  for (const file of files) {
    const { units } = analyze(file);
    const left = units.filter(
      (u) => !["header", "jsdoc", "directive"].includes(u.kind),
    );
    for (const u of left)
      console.log(
        `${path.relative(process.cwd(), file)}: [${u.kind}] ${u.value.trim().split("\n")[0]}`,
      );
  }
}

const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith("--") && a !== "--out");
const outIdx = argv.indexOf("--out");
const outPath = outIdx === -1 ? null : argv[outIdx + 1];
const paths = argv.filter((a, i) => !a.startsWith("--") && i !== outIdx + 1);
const files = paths.flatMap((p) => walk(path.resolve(p)));

if (!mode || !files.length) {
  console.error(
    "usage: ui-comments.js --inventory|--apply|--verify|--residue [--out file] <paths...>",
  );
  process.exit(2);
}

let failures = 0;
if (mode === "--inventory") inventory(files, outPath);
else if (mode === "--apply") failures = apply(files);
else if (mode === "--verify") failures = verify(files);
else if (mode === "--residue") residue(files);
process.exit(failures ? 1 : 0);
