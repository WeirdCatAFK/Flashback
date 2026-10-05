// The card-authoring guide the MCP server hands to an AI assistant on request
// (`get_card_guide`). Product content, not vault content — it ships with the app and is
// identical for every user, so it lives beside the code rather than in a vault.
//
// THE PROSE LIVES IN flashback-cards/, laid out as a Claude Skill bundle: SKILL.md (the main
// guide) and references/<section>.md (one file per section fetched on demand). Edit those
// files directly; this module only loads them. Adding a file under references/ adds a section.
//
// The files are read once at startup, relative to this module. That holds when packaged too:
// src/mcp ships inside app.asar, and the server runs under Electron with ELECTRON_RUN_AS_NODE,
// whose fs reads through asar transparently.
//
// FRONTMATTER. Each file opens with `key: value` lines between `---` fences. SKILL.md carries
// `name` and `description` — the tool's own description is composed from `description`, so
// what the model reads about when to call the tool follows it. A reference carries `title`
// and `summary`; the summary is what the main guide and the tool description list.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flashback-cards');

/** Reads a Markdown file and splits its `key: value` frontmatter from the body. */
export function readMarkdown(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const match = text.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) return { meta: {}, body: text.trim() };
    const meta = {};
    for (const line of match[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { meta, body: match[2].trim() };
}

const skill = readMarkdown(path.join(DIR, 'SKILL.md'));

const references = {};
for (const file of fs.readdirSync(path.join(DIR, 'references')).filter(f => f.endsWith('.md')).sort()) {
    const { meta, body } = readMarkdown(path.join(DIR, 'references', file));
    references[file.slice(0, -3)] = { title: meta.title, summary: meta.summary, body };
}

const flashbackCards = {
    name: skill.meta.name,
    description: skill.meta.description,
    body: skill.body,
    references,
};

export default flashbackCards;
