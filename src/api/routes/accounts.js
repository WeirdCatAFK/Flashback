/**
 * `/api/accounts` — who may reach this deployment, and as what.
 *
 * The role table in `auth/permissions.js` already decided that reaching this router at all
 * takes Admin (and `POST /pure-token` takes Author). What is left here are the rules a
 * ladder of roles cannot express, because they compare the ACTOR with the TARGET:
 *
 *   1. **An admin may only ever grant Reader.** Admins run the vault; they do not decide who
 *      else runs it. Only the Author widens the circle of people with write access.
 *   2. **An admin may not revoke their own access**, and nobody may revoke the token they are
 *      currently authenticating with. An admin who locks themselves out has no recovery path
 *      — the pure token is the Author's, and the terminal is the Author's too.
 *   3. **The Author cannot be demoted, deactivated or duplicated.** There is exactly one
 *      owner, and the only way to change what proves you are them is to rotate the pure token.
 *
 * A plaintext token appears in exactly two responses — the issue and the rotate — and never
 * again, from anywhere. There is no endpoint that reads one back, because the store does not
 * have one to read.
 */

import { Router } from 'express';
import {
    listAccounts, getAccount, getAuthorAccount, getToken,
    createAccount, updateAccount, issueToken, revokeToken, rotatePureToken,
} from '../access/primitives/accounts.js';
import { ROLES, isRole, atLeast } from '../../shared/roles.js';
import { getMaxAccounts } from '../access/primitives/config.js';
import SRS from '../access/orchestration/srs.js';
import Documents from '../access/orchestration/documents.js';
import diary from '../access/orchestration/diary.js';
import { vaultCompleteness } from './srs.js';
import { OWNER_SCOPE } from '../requestContext.js';

const router = Router();
const docs = new Documents();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (/Unknown role|needs both a name|No such account/i.test(err.message ?? '')) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    });

/** The highest role the caller may hand out. */
function grantCeiling(actor) {
    if (actor?.role === ROLES.AUTHOR) return ROLES.ADMIN;
    return ROLES.READER;
}

/**
 * @returns {{status: number, error: string}|null} why this grant is refused, or null when it is allowed. The status matters, and 403 is not the answer to every refusal. A role that is not a role is a malformed request — `catchError` above already maps the thrown form of it to 400, and answering 403 here told a client "you lack permission" when the truth was "your payload is wrong". Everything below it IS a permission decision and stays 403.
 */
function grantRefusal(actor, role) {
    if (!isRole(role)) return { status: 400, error: `Unknown role: ${role}.` };
    if (role === ROLES.AUTHOR) {
        return { status: 403, error: 'There is exactly one Author. Transfer ownership by rotating the pure token, not by granting the role.' };
    }
    const ceiling = grantCeiling(actor);
    if (!atLeast(ceiling, role)) {
        return { status: 403, error: `An ${actor.role} may grant no more than the ${ceiling} role.` };
    }
    return null;
}

/**
 * Whether adding one more active account would exceed `FLASHBACK_MAX_ACCOUNTS`.
 *
 * Only active accounts count, so deactivating one frees its slot; the Author is one of them.
 * The check lives here rather than in `createAccount()` because `ensureLocalAuthor()` calls
 * that at boot and must never be refused.
 *
 * @returns {Promise<{status: number, error: string, code: string, limit: number, count: number}|null>}
 */
async function accountLimitRefusal() {
    const limit = getMaxAccounts();
    if (limit == null) return null;
    const count = (await listAccounts()).filter((a) => a.active).length;
    if (count < limit) return null;
    return {
        status: 409,
        error: `This server allows at most ${limit} accounts.`,
        code: 'account_limit',
        limit,
        count,
    };
}

/** The response body for a refused slot: everything but the HTTP status. */
const limitBody = ({ error, code, limit, count }) => ({ error, code, limit, count });

/** Everyone who may reach this install, with their roles, and the active-account cap if any. */
router.get('/', catchError(async (req, res) => {
    res.json({ accounts: await listAccounts(), you: req.account, limit: getMaxAccounts() });
}));

/** Creates an account; an admin may grant only Reader. */
router.post('/', catchError(async (req, res) => {
    const { name, email, role } = req.body ?? {};
    const refusal = grantRefusal(req.account, role);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });

    const full = await accountLimitRefusal();
    if (full) return res.status(full.status).json(limitBody(full));

    res.status(201).json(await createAccount({ name, email, role }));
}));

/** Changes an account's role or deactivates it. */
router.patch('/:id', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const { role, active } = req.body ?? {};

    if (target.role === ROLES.AUTHOR) {
        return res.status(403).json({ error: 'The Author cannot be demoted or deactivated.' });
    }

    const ceiling = grantCeiling(req.account);
    if (!atLeast(ceiling, target.role)) {
        return res.status(403).json({
            error: `An ${req.account.role} may not modify an account with the ${target.role} role.`,
        });
    }

    if (role !== undefined) {
        const refusal = grantRefusal(req.account, role);
        if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    }
    if (active === false && target.id === req.account.id) {
        return res.status(403).json({ error: 'You cannot deactivate your own account.' });
    }
    if (active === true && !target.active) {
        const full = await accountLimitRefusal();
        if (full) return res.status(full.status).json(limitBody(full));
    }

    res.json(await updateAccount(target.id, { role, active }));
}));

/**
 * Whose schedule a target account's progress lives under: the Author's is filed under the
 * owner sentinel rather than their id (see `requestContext.js`), everyone else's under theirs.
 */
const scopeFor = (target) => (target.role === ROLES.AUTHOR ? OWNER_SCOPE : target.id);

const publicTarget = (target) => ({ id: target.id, name: target.name, email: target.email, role: target.role });

/**
 * One person's study statistics, in the shape `GET /api/srs/statistics` gives the caller
 * for themselves, completeness included. With `/:id/graph` below, one of the two endpoints
 * that read a schedule not the caller's.
 */
router.get('/:id/progress', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const scope = scopeFor(target);
    const statistics = await SRS.getStatistics({ algorithm: req.query.algorithm ?? null, scope });
    statistics.completeness = await vaultCompleteness(statistics, { scope });

    res.json({ account: publicTarget(target), scope, statistics });
}));

/** The knowledge graph with its learned halos computed from one person's schedule. */
router.get('/:id/graph', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const scope = scopeFor(target);
    const graph = await docs.getGraphData(scope);

    res.json({ account: publicTarget(target), scope, ...graph });
}));

/**
 * Someone's Logs, read-only: the days they have a summary or an entry, one day's summary, one
 * day's entry. The Author's alone (the permission table), because the prose is private writing
 * and only the server's owner is told they may read it (the Logs privacy note). An AI assistant
 * never gets these, whatever its diary access: that setting is about the caller's own diary.
 * Writing is always the caller's own, through `/api/diary`.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function logsTarget(req, res) {
    if (req.get('X-Flashback-Client') === 'mcp') {
        res.status(403).json({ error: "AI assistants cannot read other people's logs." });
        return null;
    }
    const target = await getAccount(req.params.id);
    if (!target) {
        res.status(404).json({ error: 'No such account.' });
        return null;
    }
    if (req.params.date !== undefined && !DATE_RE.test(req.params.date)) {
        res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        return null;
    }
    return target;
}

router.get('/:id/logs', catchError(async (req, res) => {
    const target = await logsTarget(req, res);
    if (!target) return;
    const from = req.query.from && DATE_RE.test(req.query.from) ? req.query.from : null;
    const to = req.query.to && DATE_RE.test(req.query.to) ? req.query.to : null;
    res.json(diary.list({ from, to, scope: scopeFor(target) }));
}));

router.get('/:id/logs/summary/:date', catchError(async (req, res) => {
    const target = await logsTarget(req, res);
    if (!target) return;
    const summary = diary.getSummary(req.params.date, scopeFor(target));
    if (!summary) return res.status(404).json({ error: 'no summary for that date' });
    res.json(summary);
}));

router.get('/:id/logs/entry/:date', catchError(async (req, res) => {
    const target = await logsTarget(req, res);
    if (!target) return;
    res.json({ date: req.params.date, content: diary.getEntry(req.params.date, scopeFor(target)) ?? '' });
}));

/** Issues a token for an account, returning its plaintext once. */
router.post('/:id/tokens', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const ceiling = grantCeiling(req.account);
    if (!atLeast(ceiling, target.role)) {
        return res.status(403).json({
            error: `An ${req.account.role} may not issue a token for an account with the ${target.role} role.`,
        });
    }

    const { id, token, label } = await issueToken(target.id, req.body?.label ?? '');
    res.status(201).json({
        id, token, label, accountId: target.id,
        notice: 'Copy this token now — it is not stored and cannot be shown again.',
    });
}));

/** Revokes one token; an admin may not revoke their own. */
router.delete('/tokens/:tokenId', catchError(async (req, res) => {
    const token = await getToken(req.params.tokenId);
    if (!token) return res.status(404).json({ error: 'No such token.' });

    if (token.id === req.tokenId) {
        return res.status(403).json({ error: 'You cannot revoke the token you are using right now.' });
    }
    if (token.accountId === req.account.id && req.account.role !== ROLES.AUTHOR) {
        return res.status(403).json({ error: 'You cannot revoke your own tokens. Ask the Author.' });
    }

    const owner = await getAccount(token.accountId);
    const ceiling = grantCeiling(req.account);
    if (owner && !atLeast(ceiling, owner.role) && owner.id !== req.account.id) {
        return res.status(403).json({
            error: `An ${req.account.role} may not revoke a token belonging to an account with the ${owner.role} role.`,
        });
    }

    await revokeToken(token.id);
    res.json({ ok: true });
}));

/** Author only: mints the token that proves ownership, revoking every previous Author token. */
router.post('/pure-token', catchError(async (req, res) => {
    const author = await getAuthorAccount();
    if (!author) return res.status(409).json({ error: 'This store has no Author yet.' });

    const { token, revoked } = await rotatePureToken(req.body?.label ?? 'Pure token');
    res.status(201).json({
        token, accountId: author.id, revoked,
        notice: 'Copy this token now — it is not stored and cannot be shown again. ' +
            `${revoked} previous author token(s) stopped working immediately.`,
    });
}));

export default router;
