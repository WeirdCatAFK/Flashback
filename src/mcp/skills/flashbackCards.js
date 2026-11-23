import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'flashback-cards');

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
