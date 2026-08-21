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

// v2 added the acquisition/review split to `retention` (see buildSummary).
export const DIARY_SCHEMA_VERSION = 2;
const STRUGGLED_CAP = 10;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The git repo root. ONE repo for the whole diary, whoever is writing into it.
function diaryRoot() { return path.join(getVaultPath(), "diary"); }

/**
 * Where one person's diary lives, relative to the repo root.
 *
 * The owner keeps the unprefixed layout the diary has always had — `summaries/`, `entries/`
 * — so no existing file moves, no git rename appears in anyone's history, and a vault written
 * before accounts existed reads back unchanged. Everyone else gets
 * `accounts/<accountId>/`. It is the same shape as the OWNER_SCOPE sentinel in the database:
 * the owner is the unmarked case, deliberately, because they are the one whose record has to
 * survive being copied to an install that has never heard of these account ids.
 *
 * One repo covers all of it, so one git history holds several people's prose. That is a real
 * property to be honest about rather than an oversight — it is what M5's "Logs" rebrand and
 * its privacy warning exist to state to the people involved. It is not a private local diary
 * once a vault is shared, and the app has to say so.
 */
function scopeDir(scope) { return isOwnerScope(scope) ? "" : `accounts/${scope}/`; }

function summariesDir(scope) { return path.join(diaryRoot(), ...scopeDir(scope).split("/").filter(Boolean), "summaries"); }
function entriesDir(scope) { return path.join(diaryRoot(), ...scopeDir(scope).split("/").filter(Boolean), "entries"); }
function summaryAbs(date, scope) { return path.join(summariesDir(scope), `summary-${date}.json`); }
function entryAbs(date, scope) { return path.join(entriesDir(scope), `entry-${date}.md`); }
// git filepaths are relative to the diary repo root, always forward-slashed.
function summaryRel(date, scope) { return `${scopeDir(scope)}summaries/summary-${date}.json`; }
function entryRel(date, scope) { return `${scopeDir(scope)}entries/entry-${date}.md`; }

// The date key for "now" — the user's local calendar day, matching
// date(timestamp, 'localtime') in query.js. Not toISOString(), which would file an
// evening session west of Greenwich under tomorrow.
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

    // ---------- git plumbing (own repo, mirrors Seal's atomic-commit pattern) ----------

    _author() {
        const config = getConfig();
        return { name: config?.vaultName || "flashback", email: "diary@flashback.local" };
    }

    // Ensures this person's {summaries,entries}/ exist and the git repo is initialized.
    // Lazy: called by every write, never at startup, so an opted-out vault stays clean.
    async _ensureInit(scope) {
        fs.mkdirSync(summariesDir(scope), { recursive: true });
        fs.mkdirSync(entriesDir(scope), { recursive: true });
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

    // Assembles the summary object for a date purely from ReviewLogs. No IO beyond
    // reads; returns null when the day has no real reviews (so we never litter the
    // diary with empty summaries).
    async buildSummary(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const totals = await query.getDayReviewTotals(date, scope);
        const reviews = totals?.reviews ?? 0;
        if (reviews === 0) return null;

        const failed = totals.failed ?? 0;
        const passRate = reviews > 0 ? (reviews - failed) / reviews : null;

        // Split the day's reviews on the same acquisition/review boundary the Stats
        // view uses: a day spent on new material reads as a low pass rate otherwise.
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
                passRate,                              // every review of the day
                reviewPassRate: rate(phase.review),    // cards past their learning phase
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

    // Writes (or overwrites) the summary for a date and commits it. Cumulative and
    // idempotent: a later session on the same day just regenerates the whole file
    // from the now-larger log set. Returns the summary, or null if the day had no
    // reviews (nothing written).
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

    // Rebuild every summary from ReviewLogs (the "rebuild diary" command). Idempotent.
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

    getSummary(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const abs = summaryAbs(date, scope);
        if (!fs.existsSync(abs)) return null;
        try {
            return JSON.parse(fs.readFileSync(abs, "utf-8"));
        } catch {
            return null; // corrupt summary — regenerable via generateSummary/rebuildAll
        }
    }

    // ---------- entries ----------

    getEntry(date, scopeArg) {
        const scope = this._scope(scopeArg);
        assertDate(date);
        const abs = entryAbs(date, scope);
        return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
    }

    // Writes the user's markdown entry for a date. Lazy: saving empty content for a
    // date with no existing entry is a no-op, so opening a day without typing never
    // litters an empty file. Returns { created, empty }.
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

    // ---------- listing ----------

    // Merged, date-descending list of days that have a summary and/or an entry,
    // optionally bounded by inclusive `from`/`to` (YYYY-MM-DD). Each item:
    // { date, hasSummary, hasEntry }. Returns [] when diary/ doesn't exist yet.
    list({ from = null, to = null, scope: scopeArg = null } = {}) {
        const scope = this._scope(scopeArg);
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
        collect(summariesDir(scope), /^summary-(\d{4}-\d{2}-\d{2})\.json$/, "hasSummary");
        collect(entriesDir(scope), /^entry-(\d{4}-\d{2}-\d{2})\.md$/, "hasEntry");
        return [...dates.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
}

export default new Diary();
