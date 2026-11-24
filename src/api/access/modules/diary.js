import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import db from "../primitives/database.js";
import * as Files from "../resources/files.js";
import * as diaryRows from '../resources/db/diary.js';
import * as statisticsRows from '../resources/db/statistics.js';
import { getVaultPath } from "../primitives/config.js";
import { removeTree } from "../primitives/removeTree.js";
import { currentScope, OWNER_SCOPE } from "../../requestContext.js";
import { sealTools } from "../../seal/seal.js";
import { LEARNING_REVIEWS } from "./srs.js";

const DIARY_SCHEMA_VERSION = 2;
const STRUGGLED_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstLineOf(text) {
    const line = String(text ?? "").split(/\r?\n/)
        .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "").replace(/[*_`~]/g, "").trim())
        .find(Boolean);
    if (!line) return null;
    return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}

function assertDate(date) {
    if (!DATE_RE.test(date)) throw new Error(`Diary date must be YYYY-MM-DD, got: ${date}`);
    return date;
}

function _scope(explicit) {
    return explicit ?? currentScope();
}

async function _streakAsOf(date, scope) {
    const DAY = 86400000;
    const days = (await statisticsRows.getReviewActivityDays(scope)).filter(d => d <= date);
    const daySet = new Set(days);
    const dateMs = Date.parse(`${date}T00:00:00Z`);
    const asStr = (ms) => new Date(ms).toISOString().slice(0, 10);

    let current = 0;
    let cursor = dateMs;
    while (daySet.has(asStr(cursor))) { current++; cursor -= DAY; }

    let longest = 0, run = 0, prev = null;
    for (const d of days) {
        const ms = Date.parse(`${d}T00:00:00Z`);
        run = (prev !== null && ms - prev === DAY) ? run + 1 : 1;
        prev = ms;
        if (run > longest) longest = run;
    }
    return { current, longest };
}

async function buildSummary(date, scope) {
    const totals = await statisticsRows.getDayReviewTotals(date, scope);
    const reviews = totals?.reviews ?? 0;
    if (reviews === 0) return null;

    const failed = totals.failed ?? 0;
    const passRate = reviews > 0 ? (reviews - failed) / reviews : null;

    const phase = await statisticsRows.getDayReviewTotalsByPhase(LEARNING_REVIEWS, date, scope);
    const rate = (t) => (t.total > 0 ? t.correct / t.total : null);

    const byDeck = (await statisticsRows.getDayByDeck(date, scope)).map(r => ({
        deck: r.deck, reviews: r.reviews, failed: r.failed ?? 0,
    }));
    const byDocument = (await statisticsRows.getDayByDocument(date, scope)).map(r => ({
        path: r.path ? r.path.replace(/\\/g, "/") : r.path, reviews: r.reviews,
    }));
    const struggledCards = (await statisticsRows.getDayStruggledCards(date, STRUGGLED_CAP, scope)).map(r => ({
        globalHash: r.globalHash,
        front: r.front ?? "(custom card)",
        failCount: r.failCount,
    }));

    return {
        schemaVersion: DIARY_SCHEMA_VERSION,
        date,
        generatedAt: new Date().toISOString(),
        totals: {
            reviews,
            uniqueCards: totals.uniqueCards ?? 0,
            newCards: await statisticsRows.getDayNewCards(date, scope),
            failed,
        },
        retention: {
            passRate,
            reviewPassRate: rate(phase.review),
            learningPassRate: rate(phase.learning),
            reviewCount: phase.review.total,
            learningCount: phase.learning.total,
        },
        byDeck,
        byDocument,
        struggledCards,
        streak: await _streakAsOf(date, scope),
    };
}

/** A past day never changes, so the index caches its summary. Flashback computes today's summary fresh on every call. */
export async function getSummary(date, scopeArg) {
    const scope = _scope(scopeArg);
    assertDate(date);
    const past = date < todayLocal();
    if (past) {
        const cached = await diaryRows.getSummary(date, scope);
        if (cached) return cached;
    }
    const summary = await buildSummary(date, scope);
    if (summary && past) await diaryRows.putSummary(date, summary, scope);
    return summary;
}

export async function generateSummary(date = todayLocal(), scopeArg) {
    const scope = _scope(scopeArg);
    assertDate(date);
    const summary = await buildSummary(date, scope);
    if (summary && date < todayLocal()) await diaryRows.putSummary(date, summary, scope);
    return summary;
}

export async function rebuildAll(scopeArg) {
    const scope = _scope(scopeArg);
    await diaryRows.clearSummaries(scope);
    let count = 0;
    for (const day of await statisticsRows.getReviewActivityDays(scope)) {
        if (await getSummary(day, scope)) count++;
    }
    return count;
}

/** An entry belongs to its writer. No function here takes the scope of another account. */
export async function getEntry(date) {
    return await diaryRows.getEntry(assertDate(date), currentScope());
}

export async function saveEntry(date, content) {
    const scope = currentScope();
    assertDate(date);
    const existed = await diaryRows.getEntry(date, scope) !== null;
    const text = content ?? "";
    const empty = text.trim() === "";
    if (empty && !existed) return { created: false, empty };

    await diaryRows.saveEntry(date, text, scope);
    return { created: !existed, empty };
}

export async function exportEntries() {
    const zip = new AdmZip();
    for (const { date, content } of await diaryRows.listEntries(currentScope())) {
        zip.addFile(`${date}.md`, Buffer.from(content, "utf-8"));
    }
    return zip.toBuffer();
}

const _inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const _newestFirst = (days) => days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

/** The days that a person studied. It says nothing about what they wrote, so the vault's author may read it. */
export async function listSummaries({ from = null, to = null, scope } = {}) {
    const activity = await statisticsRows.getReviewActivity(null, _scope(scope));
    return _newestFirst(activity
        .filter(({ day }) => _inRange(day, from, to))
        .map(({ day, total }) => ({ date: day, hasSummary: true, reviews: total })));
}

export async function list({ from = null, to = null } = {}) {
    const blank = { hasSummary: false, hasEntry: false, reviews: 0, firstLine: null };
    const days = new Map((await listSummaries({ from, to })).map((d) => [d.date, { ...blank, ...d }]));
    for (const { date, content } of await diaryRows.listEntries(currentScope())) {
        if (!_inRange(date, from, to)) continue;
        days.set(date, { ...blank, date, ...days.get(date), hasEntry: true, firstLine: firstLineOf(content) });
    }
    return _newestFirst([...days.values()]);
}

function _filesIn(dir, scope, pattern) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .map((name) => ({ scope, date: name.match(pattern)?.[1], file: path.join(dir, name) }))
        .filter(({ date }) => date);
}

const _foldersIn = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : []);

/**
 * Older builds kept entries as files in {vault}/diary/, and then in workspace/_diary/.
 * Copies each entry into the progress store, never over one that is there, and keeps the files as diary.legacy.
 * It deletes _diary/ from the Seal history, and the folder last, so an interrupted run happens again at the next start.
 */
export async function adoptFiles() {
    const legacy = path.join(getVaultPath(), "diary");
    const shared = Files.reservedPath("_diary");
    if (!fs.existsSync(legacy) && !fs.existsSync(shared)) return 0;

    const oldName = /^entry-(\d{4}-\d{2}-\d{2})\.md$/;
    const entries = [
        ..._foldersIn(shared).flatMap((id) => _filesIn(path.join(shared, id), id, /^(\d{4}-\d{2}-\d{2})\.md$/)),
        ..._filesIn(path.join(legacy, "entries"), OWNER_SCOPE, oldName),
        ..._foldersIn(path.join(legacy, "accounts"))
            .flatMap((id) => _filesIn(path.join(legacy, "accounts", id, "entries"), id, oldName)),
    ];
    let adopted = 0;
    await db.transaction(async () => {
        for (const { scope, date, file } of entries) {
            if (await diaryRows.addEntry(date, fs.readFileSync(file, "utf-8"), scope)) adopted++;
        }
    })();

    if (fs.existsSync(shared)) {
        console.log("Deleting the diary from the Seal history. This runs once and can take a minute.");
        await sealTools.forget("_diary");
        _setAside(shared, legacy);
    }
    if (fs.existsSync(legacy)) _setAside(legacy, legacy);
    return adopted;
}

/** Copies and then removes, because the workspace can be on another volume and a sync client can refuse a folder rename. */
function _setAside(dir, legacy) {
    const name = `${legacy}.legacy`;
    fs.cpSync(dir, fs.existsSync(name) ? `${name}-${crypto.randomUUID().slice(0, 8)}` : name, { recursive: true });
    removeTree(dir);
}
