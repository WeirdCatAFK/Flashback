import { Router } from 'express';
import {
    listAccounts, getAccount, getAuthorAccount, getToken,
    createAccount, updateAccount, issueToken, revokeToken, rotatePureToken,
} from '../access/primitives/accounts.js';
import { ROLES, isRole, atLeast } from '../../shared/roles.js';
import { getMaxAccounts } from '../access/primitives/config.js';
import * as Srs from '../access/modules/srs.js';
import * as Documents from '../access/modules/documents.js';
import * as Diary from '../access/modules/diary.js';
import { vaultCompleteness } from './srs.js';
import { OWNER_SCOPE } from '../requestContext.js';

const router = Router();

const catchError = (fn) => (req, res, next) =>
    Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
        if (/Unknown role|needs both a name|No such account/i.test(err.message ?? '')) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    });

function grantCeiling(actor) {
    if (actor?.role === ROLES.AUTHOR) return ROLES.ADMIN;
    return ROLES.READER;
}

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

/** The cap lives here, not in createAccount(), because ensureLocalAuthor() calls createAccount() at boot and must never be refused. */
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

const limitBody = ({ error, code, limit, count }) => ({ error, code, limit, count });

router.get('/', catchError(async (req, res) => {
    res.json({ accounts: await listAccounts(), you: req.account, limit: getMaxAccounts() });
}));

router.post('/', catchError(async (req, res) => {
    const { name, email, role } = req.body ?? {};
    const refusal = grantRefusal(req.account, role);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });

    const full = await accountLimitRefusal();
    if (full) return res.status(full.status).json(limitBody(full));

    res.status(201).json(await createAccount({ name, email, role }));
}));

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

const scopeFor = (target) => (target.role === ROLES.AUTHOR ? OWNER_SCOPE : target.id);

const publicTarget = (target) => ({ id: target.id, name: target.name, email: target.email, role: target.role });

router.get('/:id/progress', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const scope = scopeFor(target);
    const statistics = await Srs.getStatistics({ algorithm: req.query.algorithm ?? null, scope });
    statistics.completeness = await vaultCompleteness(statistics, { scope });

    res.json({ account: publicTarget(target), scope, statistics });
}));

router.get('/:id/graph', catchError(async (req, res) => {
    const target = await getAccount(req.params.id);
    if (!target) return res.status(404).json({ error: 'No such account.' });

    const scope = scopeFor(target);
    const graph = await Documents.getGraphData(scope);

    res.json({ account: publicTarget(target), scope, ...graph });
}));

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
    res.json(await Diary.list({ from, to, scope: scopeFor(target) }));
}));

router.get('/:id/logs/summary/:date', catchError(async (req, res) => {
    const target = await logsTarget(req, res);
    if (!target) return;
    const summary = await Diary.getSummary(req.params.date, scopeFor(target));
    if (!summary) return res.status(404).json({ error: 'no summary for that date' });
    res.json(summary);
}));

router.get('/:id/logs/entry/:date', catchError(async (req, res) => {
    const target = await logsTarget(req, res);
    if (!target) return;
    res.json({ date: req.params.date, content: Diary.getEntry(req.params.date, scopeFor(target)) ?? '' });
}));

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
