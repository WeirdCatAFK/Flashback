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

/** Everyone who may reach this install, with their roles. */
router.get('/', catchError(async (req, res) => {
    res.json({ accounts: await listAccounts(), you: req.account });
}));

/** Creates an account; an admin may grant only Reader. */
router.post('/', catchError(async (req, res) => {
    const { name, email, role } = req.body ?? {};
    const refusal = grantRefusal(req.account, role);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });

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

    res.json(await updateAccount(target.id, { role, active }));
}));

/** One person's study statistics; the only endpoint that reads a schedule not the caller's. */
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
