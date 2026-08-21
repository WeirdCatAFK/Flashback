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
import SRS from '../access/orchestration/srs.js';
import { OWNER_SCOPE } from '../requestContext.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (/Unknown role|needs both a name|No such account/i.test(err.message ?? '')) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    });

/**
 * The highest role the caller may hand out.
 *
 * An Author may create anyone below them; an Admin may create Readers only. Expressed as a
 * ceiling rather than a list so it stays right if a role is ever inserted into the ladder.
 */
function grantCeiling(actor) {
    if (actor?.role === ROLES.AUTHOR) return ROLES.ADMIN;
    return ROLES.READER;
}

/**
 * @returns {{status: number, error: string}|null} why this grant is refused, or null when it
 * is allowed.
 *
 * The status matters, and 403 is not the answer to every refusal. A role that is not a role
 * is a malformed request — `catchError` above already maps the thrown form of it to 400, and
 * answering 403 here told a client "you lack permission" when the truth was "your payload is
 * wrong". Everything below it IS a permission decision and stays 403.
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

// GET /api/accounts — every account with its token metadata. Never a hash, never a plaintext.
router.get('/', catchError(async (req, res) => {
    res.json({ accounts: await listAccounts(), you: req.account });
}));

// POST /api/accounts
// Body: { name, email, role }
router.post('/', catchError(async (req, res) => {
    const { name, email, role } = req.body ?? {};
    const refusal = grantRefusal(req.account, role);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });

    res.status(201).json(await createAccount({ name, email, role }));
}));

// PATCH /api/accounts/:id
// Body: { role?, active? }
router.patch('/:id', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const { role, active } = req.body ?? {};

    if (target.role === ROLES.AUTHOR) {
        return res.status(403).json({ error: 'The Author cannot be demoted or deactivated.' });
    }
    if (role !== undefined) {
        const refusal = grantRefusal(req.account, role);
        if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    }
    // Deactivating an account kills every token it holds at once, so it is the same
    // self-lockout as revoking a token and is refused for the same reason.
    if (active === false && target.id === req.account.id) {
        return res.status(403).json({ error: 'You cannot deactivate your own account.' });
    }

    res.json(await updateAccount(target.id, { role, active }));
}));

// GET /api/accounts/:id/progress — one account's study record, for the Server view's
// admin panel. Admin-gated by the role table, like everything else on this router.
//
// This is the ONE place in the app that reads a schedule belonging to somebody else, and it
// exists because a shared vault's admin has to be able to answer "is anyone actually using
// this?". It is a summary — reviews, retention, streak, due count — not a second Stats view.
//
// The scope translation is the part worth reading twice. Progress is keyed by an account
// SCOPE, and the Author's scope is the literal 'owner' rather than their account id (see
// requestContext.js: an id from accounts.db would orphan every row the moment the vault
// folder was copied). So asking for the Author's progress by their id has to be translated,
// or it silently reports an empty schedule for the one person who has been studying longest.
router.get('/:id/progress', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const scope = target.role === ROLES.AUTHOR ? OWNER_SCOPE : target.id;
    const statistics = await SRS.getStatistics({ algorithm: req.query.algorithm ?? null, scope });

    res.json({
        account: { id: target.id, name: target.name, email: target.email, role: target.role },
        scope,
        statistics,
    });
}));

// POST /api/accounts/:id/tokens
// Body: { label? }
// The plaintext token is in this response and nowhere else, ever.
router.post('/:id/tokens', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    // Issuing a token for an account is handing out that account's role, so it is governed
    // by the same ceiling as granting the role would be. Without this an admin could mint
    // themselves an author token through the back door.
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

// DELETE /api/accounts/tokens/:tokenId
router.delete('/tokens/:tokenId', catchError(async (req, res) => {
    const token = await getToken(req.params.tokenId);
    if (!token) return res.status(404).json({ error: 'No such token.' });

    if (token.id === req.tokenId) {
        return res.status(403).json({ error: 'You cannot revoke the token you are using right now.' });
    }
    // An admin who revokes their last token has no way back in: the pure token belongs to the
    // Author and so does the terminal. The Author is exempt because they have both.
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

// POST /api/accounts/pure-token
// Author only (enforced by the role table). Mints the token that proves ownership and
// revokes every previous Author token in the same transaction.
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
