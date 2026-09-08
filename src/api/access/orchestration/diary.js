/**
 * Diary — a per-day record of study activity, living OUTSIDE the workspace graph.
 *
 * Two kinds of files, joined only by their date key (never sidecars of each other):
 *   summaries/summary-YYYY-MM-DD.json  — machine-written, structured stats (canonical, read-only in UI)
 *   entries/entry-YYYY-MM-DD.md        — optional user-written markdown reflection
 *
 * Design decisions (see DATAMODEL.md § Diary):
 *  - Location `{vault}/diary/` is a SIBLING of `{vault}/workspace`. Because the file
 *    walker, search, and knowledge graph only ever descend inside workspaceRoot, diary
 *    files are invisible to them for free — no exclusion code needed. The trade-off is
 *    that Seal (whose git repo root IS the workspace) does not version diary files, so
 *    diary/ carries its OWN isomorphic-git repo, committed with the same atomic pattern.
 *  - Summaries are DERIVED data: fully regenerable from ReviewLogs. generateSummary() is
 *    idempotent and cumulative — re-running it for a past date reproduces the same file
 *    (modulo `generatedAt`), which is what makes "rebuild diary" safe.
 *  - Day boundary is the user's LOCAL calendar day (date(timestamp, 'localtime') in
 *    SQLite), matching the Stats view. The API runs on the user's own machine, so its
 *    local time is the clock they were studying by; bucketing in UTC filed evening
 *    sessions west of Greenwich under the next day's summary.
 *
 * Opt-in is a client preference (localStorage), so the server never auto-creates diary/:
 * every write lazily inits the repo, and reads no-op cleanly when the folder is absent.
 * This is a Tier 3 orchestrator; it talks to query.js (for aggregates) and its own git
 * repo. It never imports documents/files, and from srs.js it takes only the shared
 * LEARNING_REVIEWS constant (no service, no scheduling) so the day's pass rate is split
 * on exactly the same boundary the Stats view uses — diary data is metadata about
 * studying, not study material.
 */
import git from "isomorphic-git";
import fs from "fs";
import path from "path";
import { getVaultPath, get as getConfig } from "../primitives/config.js";
import query from "../resources/query.js";
import { currentScope, isOwnerScope } from "../../requestContext.js";
import { LEARNING_REVIEWS } from "./srs.js";

export const DIARY_SCHEMA_VERSION = 2;
const STRUGGLED_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function diaryRoot() { return path.join(getVaultPath(), "diary"); }

/** Where one person's diary lives, relative to the repo root. */
function scopeDir(scope) { return isOwnerScope(scope) ? "" : `accounts/${scope}/`; }

function summariesDir(scope) { return path.join(diaryRoot(), ...scopeDir(scope).split("/").filter(Boolean), "summaries"); }
function entriesDir(scope) { return path.join(diaryRoot(), ...scopeDir(scope).split("/").filter(Boolean), "entries"); }
function summaryAbs(date, scope) { return path.join(summariesDir(scope), `summary-${date}.json`); }
function entryAbs(date, scope) { return path.join(entriesDir(scope), `entry-${date}.md`); }
function summaryRel(date, scope) { return `${scopeDir(scope)}summaries/summary-${date}.json`; }
function entryRel(date, scope) { return `${scopeDir(scope)}entries/entry-${date}.md`; }

function todayLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function assertDate(date) {
    if (!DATE_RE.test(date)) throw new Error(`Diary date must be YYYY-MM-DD, got: ${date}`);
    return date;
}

class Diary {
    /** Whose diary this is. Resolved once per public entry point, like srs.js. */
    _scope(explicit) {
        return explicit ?? currentScope();
    }

    _author() {
        const config = getConfig();
        return { name: config?.vaultName || "flashback", email: "diary@flashback.local" };
    }

    async _ensureInit(scope) {
        fs.mkdirSync(summariesDir(scope), { recursive: true });
        fs.mkdirSync(entriesDir(scope), { recursive: true });
        const root = diaryRoot();
        const initialized = await git.resolveRef({ fs, dir: root, ref: "HEAD" })
            .then(() => true)
            .catch(() => false);
        if (!initialized) await git.init({ fs, dir: root });
    }

    _atomicWrite(absFile, content) {
        const tmp = `${absFile}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, absFile);
    }

    async _commit(relPaths, message) {
        const root = diaryRoot();
        for (const p of relPaths) await git.add({ fs, dir: root, filepath: p });
        await git.commit({ fs, dir: root, message, author: this._author() });
    }

    async _streakAsOf(date, scope) {
        const DAY = 86400000;
        const days = (await query.getReviewActivityDays(scope)).filter(d => d <= date);
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

    /** Derives one day's summary from the review ledger, without writing it. */
    async buildSummary(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const totals = await query.getDayReviewTotals(date, scope);
        const reviews = totals?.reviews ?? 0;
        if (reviews === 0) return null;

        const failed = totals.failed ?? 0;
        const passRate = reviews > 0 ? (reviews - failed) / reviews : null;

        const phase = await query.getDayReviewTotalsByPhase(LEARNING_REVIEWS, date, scope);
        const rate = (t) => (t.total > 0 ? t.correct / t.total : null);

        const byDeck = (await query.getDayByDeck(date, scope)).map(r => ({
            deck: r.deck, reviews: r.reviews, failed: r.failed ?? 0,
        }));
        const byDocument = (await query.getDayByDocument(date, scope)).map(r => ({
            path: r.path ? r.path.replace(/\\/g, "/") : r.path, reviews: r.reviews,
        }));
        const struggledCards = (await query.getDayStruggledCards(date, STRUGGLED_CAP, scope)).map(r => ({
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
                newCards: await query.getDayNewCards(date, scope),
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
            streak: await this._streakAsOf(date, scope),
        };
    }

    /** Derives and stores one day's summary; idempotent. */
    async generateSummary(date = todayLocal(), scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const summary = await this.buildSummary(date, scope);
        if (!summary) return null;
        await this._ensureInit(scope);
        this._atomicWrite(summaryAbs(date, scope), JSON.stringify(summary, null, 2) + "\n");
        await this._commit([summaryRel(date, scope)], `summary: ${summaryRel(date, scope)}`);
        return summary;
    }

    /** Re-derives every summary in a date range. */
    async rebuildAll(scopeArg) {
        const scope = this._scope(scopeArg);
        const days = await query.getReviewActivityDays(scope);
        let count = 0;
        for (const day of days) {
            const summary = await this.buildSummary(day, scope);
            if (!summary) continue;
            await this._ensureInit(scope);
            this._atomicWrite(summaryAbs(day, scope), JSON.stringify(summary, null, 2) + "\n");
            await this._commit([summaryRel(day, scope)], `summary: ${summaryRel(day, scope)}`);
            count++;
        }
        return count;
    }

    /** One day's stored summary. */
    getSummary(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const abs = summaryAbs(date, scope);
        if (!fs.existsSync(abs)) return null;
        try {
            return JSON.parse(fs.readFileSync(abs, "utf-8"));
        } catch {
            return null;
        }
    }

    /** One day's written entry. */
    getEntry(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const abs = entryAbs(date, scope);
        return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
    }

    /** Writes one day's entry and commits it to the diary repo. */
    async saveEntry(date, content, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const abs = entryAbs(date, scope);
        const existed = fs.existsSync(abs);
        const text = content ?? "";

        if (text.trim() === "" && !existed) return { created: false, empty: true };

        await this._ensureInit(scope);
        this._atomicWrite(abs, text);
        await this._commit([entryRel(date, scope)], `entry: ${entryRel(date, scope)}`);
        return { created: !existed, empty: text.trim() === "" };
    }

    /** Every day this person has a summary or an entry for, newest first. */
    list({ from = null, to = null, scope: scopeArg = null } = {}) {
        const scope = this._scope(scopeArg);
        const dates = new Map();
        const collect = (dir, re, key) => {
            if (!fs.existsSync(dir)) return;
            for (const name of fs.readdirSync(dir)) {
                const m = name.match(re);
                if (!m) continue;
                const d = m[1];
                if (from && d < from) continue;
                if (to && d > to) continue;
                const entry = dates.get(d) || { date: d, hasSummary: false, hasEntry: false };
                entry[key] = true;
                dates.set(d, entry);
            }
        };
        collect(summariesDir(scope), /^summary-(\d{4}-\d{2}-\d{2})\.json$/, "hasSummary");
        collect(entriesDir(scope), /^entry-(\d{4}-\d{2}-\d{2})\.md$/, "hasEntry");
        return [...dates.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
}

export default new Diary();
