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
 *  - Day boundary is UTC (date(timestamp) in SQLite), matching the Stats view.
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
import { getVaultPath, get as getConfig } from "./config.js";
import query from "./query.js";
import { LEARNING_REVIEWS } from "./srs.js";

// v2 added the acquisition/review split to `retention` (see buildSummary).
export const DIARY_SCHEMA_VERSION = 2;
const STRUGGLED_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function diaryRoot() { return path.join(getVaultPath(), "diary"); }
function summariesDir() { return path.join(diaryRoot(), "summaries"); }
function entriesDir() { return path.join(diaryRoot(), "entries"); }
function summaryAbs(date) { return path.join(summariesDir(), `summary-${date}.json`); }
function entryAbs(date) { return path.join(entriesDir(), `entry-${date}.md`); }
// git filepaths are relative to the diary repo root, always forward-slashed.
function summaryRel(date) { return `summaries/summary-${date}.json`; }
function entryRel(date) { return `entries/entry-${date}.md`; }

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function assertDate(date) {
    if (!DATE_RE.test(date)) throw new Error(`Diary date must be YYYY-MM-DD, got: ${date}`);
    return date;
}

class Diary {
    // ---------- git plumbing (own repo, mirrors Seal's atomic-commit pattern) ----------

    _author() {
        const config = getConfig();
        return { name: config?.vaultName || "flashback", email: "diary@flashback.local" };
    }

    // Ensures diary/{summaries,entries}/ exist and the git repo is initialized.
    // Lazy: called by every write, never at startup, so an opted-out vault stays clean.
    async _ensureInit() {
        fs.mkdirSync(summariesDir(), { recursive: true });
        fs.mkdirSync(entriesDir(), { recursive: true });
        const root = diaryRoot();
        const initialized = await git.resolveRef({ fs, dir: root, ref: "HEAD" })
            .then(() => true)
            .catch(() => false);
        if (!initialized) await git.init({ fs, dir: root });
    }

    // Atomic write (temp + rename) so a crash mid-write never leaves a half file.
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

    // ---------- summaries ----------

    // Study-streak lengths AS OF `date`, derived from the full set of active days.
    // Computing relative to the date (not wall-clock "now") keeps regeneration of a
    // past summary idempotent. `current` = consecutive active days ending on `date`
    // (0 if `date` itself had no activity); `longest` = longest run among days <= date.
    _streakAsOf(date) {
        const DAY = 86400000;
        const days = query.getReviewActivityDays().filter(d => d <= date);
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

    // Assembles the summary object for a date purely from ReviewLogs. No IO beyond
    // reads; returns null when the day has no real reviews (so we never litter the
    // diary with empty summaries).
    buildSummary(date) {
        assertDate(date);
        const totals = query.getDayReviewTotals(date);
        const reviews = totals?.reviews ?? 0;
        if (reviews === 0) return null;

        const failed = totals.failed ?? 0;
        const passRate = reviews > 0 ? (reviews - failed) / reviews : null;

        // Split the day's reviews on the same acquisition/review boundary the Stats
        // view uses: a day spent on new material reads as a low pass rate otherwise.
        const phase = query.getDayReviewTotalsByPhase(LEARNING_REVIEWS, date);
        const rate = (t) => (t.total > 0 ? t.correct / t.total : null);

        const byDeck = query.getDayByDeck(date).map(r => ({
            deck: r.deck, reviews: r.reviews, failed: r.failed ?? 0,
        }));
        const byDocument = query.getDayByDocument(date).map(r => ({
            path: r.path ? r.path.replace(/\\/g, "/") : r.path, reviews: r.reviews,
        }));
        const struggledCards = query.getDayStruggledCards(date, STRUGGLED_CAP).map(r => ({
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
                newCards: query.getDayNewCards(date),
                failed,
            },
            retention: {
                passRate,                              // every review of the day
                reviewPassRate: rate(phase.review),    // cards past their learning phase
                learningPassRate: rate(phase.learning),
                reviewCount: phase.review.total,
                learningCount: phase.learning.total,
            },
            byDeck,
            byDocument,
            struggledCards,
            streak: this._streakAsOf(date),
        };
    }

    // Writes (or overwrites) the summary for a date and commits it. Cumulative and
    // idempotent: a later session on the same day just regenerates the whole file
    // from the now-larger log set. Returns the summary, or null if the day had no
    // reviews (nothing written).
    async generateSummary(date = todayUtc()) {
        assertDate(date);
        const summary = this.buildSummary(date);
        if (!summary) return null;
        await this._ensureInit();
        this._atomicWrite(summaryAbs(date), JSON.stringify(summary, null, 2) + "\n");
        await this._commit([summaryRel(date)], `summary: ${summaryRel(date)}`);
        return summary;
    }

    // Rebuild every summary from ReviewLogs (the "rebuild diary" command). Idempotent.
    async rebuildAll() {
        const days = query.getReviewActivityDays();
        let count = 0;
        for (const day of days) {
            const summary = this.buildSummary(day);
            if (!summary) continue;
            await this._ensureInit();
            this._atomicWrite(summaryAbs(day), JSON.stringify(summary, null, 2) + "\n");
            await this._commit([summaryRel(day)], `summary: ${summaryRel(day)}`);
            count++;
        }
        return count;
    }

    getSummary(date) {
        assertDate(date);
        const abs = summaryAbs(date);
        if (!fs.existsSync(abs)) return null;
        try {
            return JSON.parse(fs.readFileSync(abs, "utf-8"));
        } catch {
            return null; // corrupt summary — regenerable via generateSummary/rebuildAll
        }
    }

    // ---------- entries ----------

    getEntry(date) {
        assertDate(date);
        const abs = entryAbs(date);
        return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
    }

    // Writes the user's markdown entry for a date. Lazy: saving empty content for a
    // date with no existing entry is a no-op, so opening a day without typing never
    // litters an empty file. Returns { created, empty }.
    async saveEntry(date, content) {
        assertDate(date);
        const abs = entryAbs(date);
        const existed = fs.existsSync(abs);
        const text = content ?? "";

        if (text.trim() === "" && !existed) return { created: false, empty: true };

        await this._ensureInit();
        this._atomicWrite(abs, text);
        await this._commit([entryRel(date)], `entry: ${entryRel(date)}`);
        return { created: !existed, empty: text.trim() === "" };
    }

    // ---------- listing ----------

    // Merged, date-descending list of days that have a summary and/or an entry,
    // optionally bounded by inclusive `from`/`to` (YYYY-MM-DD). Each item:
    // { date, hasSummary, hasEntry }. Returns [] when diary/ doesn't exist yet.
    list({ from = null, to = null } = {}) {
        const dates = new Map(); // date -> { hasSummary, hasEntry }
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
        collect(summariesDir(), /^summary-(\d{4}-\d{2}-\d{2})\.json$/, "hasSummary");
        collect(entriesDir(), /^entry-(\d{4}-\d{2}-\d{2})\.md$/, "hasEntry");
        return [...dates.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
}

export default new Diary();
