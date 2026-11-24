import fs from "fs";
import path from "path";
import * as Files from "../resources/files.js";
import { withDocument } from "../resources/pathLock.js";
import * as diaryRows from '../resources/db/diary.js';
import * as statisticsRows from '../resources/db/statistics.js';
import { getVaultPath, getAuthorString } from "../primitives/config.js";
import { getAccount } from "../primitives/accounts.js";
import { currentScope, isOwnerScope, currentAuthorString, OWNER_SCOPE } from "../../requestContext.js";
import { sealEmitter } from "../../seal/seal.js";
import { LATEST_VERSION } from "../../config/updates/registry.js";
import { LEARNING_REVIEWS } from "./srs.js";

const DIARY_SCHEMA_VERSION = 2;
const STRUGGLED_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DIARY_DIR = "_diary";

/** The owner writes to _diary/owner/. Every other account writes to _diary/<accountId>/, and the folder sidecar names its author. */
function folderOf(scope) {
    if (isOwnerScope(scope)) return OWNER_SCOPE;
    if (!/^[\w-]+$/.test(scope)) throw new Error(`Invalid diary scope: ${scope}`);
    return scope;
}

const folderRel = (scope) => path.join(DIARY_DIR, folderOf(scope));
const entryRel = (date, scope) => path.join(folderRel(scope), `${date}.md`);
const sidecarRel = (scope) => path.join(folderRel(scope), ".flashback");

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

function _ensureFolder(scope, createdBy) {
    if (Files.readReserved(sidecarRel(scope)) !== null) return false;
    const sidecar = {
        formatVersion: LATEST_VERSION,
        createdBy,
        createdAt: new Date().toISOString(),
        accountId: isOwnerScope(scope) ? null : scope,
    };
    Files.writeReserved(sidecarRel(scope), JSON.stringify(sidecar, null, 2) + "\n");
    return true;
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

export function getEntry(date, scopeArg) {
    const scope = _scope(scopeArg);
    assertDate(date);
    return Files.readReserved(entryRel(date, scope));
}

export async function saveEntry(date, content, scopeArg) {
    const scope = _scope(scopeArg);
    assertDate(date);
    const rel = entryRel(date, scope);
    return await withDocument(rel, async () => {
        const existed = Files.readReserved(rel) !== null;
        const text = content ?? "";
        if (text.trim() === "" && !existed) return { created: false, empty: true };

        const newFolder = _ensureFolder(scope, currentAuthorString(getAuthorString));
        Files.writeReserved(rel, text);
        await sealEmitter.edit(rel, newFolder ? [sidecarRel(scope)] : []);
        return { created: !existed, empty: text.trim() === "" };
    });
}

export async function list({ from = null, to = null, scope: scopeArg = null } = {}) {
    const scope = _scope(scopeArg);
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    const dates = new Map();
    const day = (d) => dates.get(d) ?? dates.set(d, { date: d, hasSummary: false, hasEntry: false, reviews: 0, firstLine: null }).get(d);

    for (const { day: d, total } of await statisticsRows.getReviewActivity(null, scope)) {
        if (!inRange(d)) continue;
        Object.assign(day(d), { hasSummary: true, reviews: total });
    }
    for (const name of Files.listReserved(folderRel(scope))) {
        const m = name.match(ENTRY_RE);
        if (!m || !inRange(m[1])) continue;
        Object.assign(day(m[1]), { hasEntry: true, firstLine: firstLineOf(Files.readReserved(path.join(folderRel(scope), name))) });
    }
    return [...dates.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function _authorOf(accountId) {
    try {
        const account = await getAccount(accountId);
        if (account?.name && account?.email) return `${account.name} <${account.email}>`;
    } catch { }
    return null;
}

/** Moves the diary of an older build, {vault}/diary/, into _diary/. It never overwrites an entry, so a second run is harmless, and it keeps the old folder as diary.legacy. */
export async function adoptLegacyFolder() {
    const legacy = path.join(getVaultPath(), "diary");
    if (!fs.existsSync(legacy)) return 0;

    const sources = [{ scope: OWNER_SCOPE, dir: path.join(legacy, "entries"), createdBy: getAuthorString() }];
    const accountsDir = path.join(legacy, "accounts");
    if (fs.existsSync(accountsDir)) {
        for (const id of fs.readdirSync(accountsDir)) {
            sources.push({ scope: id, dir: path.join(accountsDir, id, "entries"), createdBy: await _authorOf(id) });
        }
    }

    const written = [];
    for (const { scope, dir, createdBy } of sources) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const m = name.match(/^entry-(\d{4}-\d{2}-\d{2})\.md$/);
            if (!m) continue;
            const rel = entryRel(m[1], scope);
            if (Files.readReserved(rel) !== null) continue;
            if (_ensureFolder(scope, createdBy)) written.push(sidecarRel(scope));
            Files.writeReserved(rel, fs.readFileSync(path.join(dir, name), "utf-8"));
            written.push(rel);
        }
    }
    if (written.length) await sealEmitter.edit(written[0], written.slice(1));
    const moved = written.filter((p) => p.endsWith(".md")).length;

    const target = fs.existsSync(`${legacy}.legacy`) ? `${legacy}.legacy-${Date.now()}` : `${legacy}.legacy`;
    fs.renameSync(legacy, target);
    return moved;
}
