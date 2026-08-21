/**
 * The accounts store, the permission table, and the rules that sit between them.
 *
 * Three things are being pinned here, and they fail in different ways:
 *
 *   1. **The store.** Ordinary CRUD, plus the two properties that are security-relevant: a
 *      plaintext token is never recoverable, and a revoked token stops resolving.
 *   2. **The permission table.** Pure resolution — no HTTP, no database. The important test
 *      is not that any particular rule is right (rules are a product decision and will
 *      change) but that the table FAILS CLOSED: an unlisted mount, an unknown role and a
 *      missing account must all be refused rather than waved through.
 *   3. **The coverage assertion.** Every router mounted in `api.js` has an entry. Without it
 *      the failure mode of adding a route is silence — it would resolve to author-only and
 *      look broken to admins, or worse, someone would "fix" that with a catch-all.
 *
 * The store lives at `{USER_DATA_PATH}/accounts.db`, so this file points USER_DATA_PATH at a
 * scratch directory of its own before importing anything. It never touches a vault.
 *
 * Run: node --test tests/accounts.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

const ROOT = path.join(process.cwd(), 'data_test_accounts');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(
    path.join(ROOT, 'config.json'),
    JSON.stringify({
        port: 0, logFormat: 'dev', host: 'localhost', isLocalhost: true,
        isCustomPath: false, customPath: '', vaultName: 'accounts',
        user: { name: 'Local Owner', email: 'owner@example.com' },
    }, null, 2),
);

const accounts = await import('../src/api/access/primitives/accounts.js');
const { ROLES, atLeast, roleRank } = await import('../src/shared/roles.js');
const { requiredRole, PERMISSIONS } = await import('../src/api/auth/permissions.js');

after(() => {
    accounts.closeAccounts();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
});

/**
 * Empties the store between describe blocks.
 *
 * Closes the handle and deletes the file rather than issuing DELETEs, so each block starts
 * against a store that has genuinely never been opened — which is the state `ensureLocalAuthor`
 * has to handle. The adapter re-opens lazily on the next query and recreates the schema.
 */
function reset() {
    accounts.closeAccounts();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(path.join(ROOT, `accounts.db${suffix}`), { force: true });
    }
}

describe('roles', () => {
    it('is a strict ladder', () => {
        assert.ok(roleRank(ROLES.READER) < roleRank(ROLES.COLLABORATOR));
        assert.ok(roleRank(ROLES.COLLABORATOR) < roleRank(ROLES.ADMIN));
        assert.ok(roleRank(ROLES.ADMIN) < roleRank(ROLES.AUTHOR));
    });

    it('refuses anything that is not a role', () => {
        // The guard compares req.account?.role against a rule. A corrupt row, a null account
        // or a role from a future version must never satisfy a requirement.
        assert.equal(atLeast(undefined, ROLES.READER), false);
        assert.equal(atLeast('superuser', ROLES.READER), false);
        assert.equal(atLeast(ROLES.AUTHOR, 'superuser'), false);
    });
});

describe('accounts store', () => {
    before(() => { reset(); });

    it('provisions one Author from the local identity, idempotently', async () => {
        const first = await accounts.ensureLocalAuthor(null);
        assert.equal(first.role, ROLES.AUTHOR);
        assert.equal(first.name, 'Local Owner');
        assert.equal(first.email, 'owner@example.com');

        const again = await accounts.ensureLocalAuthor(null);
        assert.equal(again.id, first.id, 'a second boot must not create a second Author');
        assert.equal((await accounts.listAccounts()).length, 1);
    });

    it("adopts this install's apiToken as the Author's token", async () => {
        // This is the whole reason a desktop install notices nothing: the renderer and the
        // MCP server keep presenting the token they already hold.
        const author = await accounts.ensureLocalAuthor('desktop-token-abc');
        const resolved = await accounts.resolveToken('desktop-token-abc');
        assert.equal(resolved?.account.id, author.id);
        assert.equal(resolved?.account.role, ROLES.AUTHOR);

        await accounts.ensureLocalAuthor('desktop-token-abc');
        const tokens = (await accounts.listAccounts())[0].tokens;
        assert.equal(tokens.length, 1, 'adoption must not add a duplicate row each boot');
    });

    it('stores no plaintext, so an issued token is unrecoverable', async () => {
        const author = await accounts.getAuthorAccount();
        const { token } = await accounts.issueToken(author.id, 'laptop');

        const raw = fs.readFileSync(path.join(ROOT, 'accounts.db'));
        assert.ok(!raw.includes(Buffer.from(token)), 'the plaintext must not be in the file');

        // And the read path never returns one either.
        const listed = (await accounts.listAccounts())[0].tokens;
        for (const t of listed) {
            assert.ok(!('token' in t) && !('hash' in t) && !('token_hash' in t));
        }
        assert.equal((await accounts.resolveToken(token))?.account.id, author.id);
    });

    it('stops resolving a revoked token but leaves the others working', async () => {
        const author = await accounts.getAuthorAccount();
        const a = await accounts.issueToken(author.id, 'one');
        const b = await accounts.issueToken(author.id, 'two');

        assert.equal(await accounts.revokeToken(a.id), true);
        assert.equal(await accounts.resolveToken(a.token), null);
        assert.equal((await accounts.resolveToken(b.token))?.account.id, author.id);

        // Idempotent: a second revoke reports success without moving the timestamp.
        const before = (await accounts.getToken(a.id)).revokedAt;
        assert.equal(await accounts.revokeToken(a.id), true);
        assert.equal((await accounts.getToken(a.id)).revokedAt, before);
    });

    it('deactivating an account stops every token it holds at once', async () => {
        const reader = await accounts.createAccount({
            name: 'Reader', email: 'reader@example.com', role: ROLES.READER,
        });
        const one = await accounts.issueToken(reader.id, 'phone');
        const two = await accounts.issueToken(reader.id, 'tablet');

        await accounts.updateAccount(reader.id, { active: false });
        assert.equal(await accounts.resolveToken(one.token), null);
        assert.equal(await accounts.resolveToken(two.token), null);

        await accounts.updateAccount(reader.id, { active: true });
        assert.equal((await accounts.resolveToken(one.token))?.account.id, reader.id);
    });

    it('refuses a role that does not exist, and a half-filled identity', async () => {
        await assert.rejects(
            accounts.createAccount({ name: 'X', email: 'x@example.com', role: 'superuser' }),
            /Unknown role/,
        );
        await assert.rejects(
            accounts.createAccount({ name: 'X', email: '', role: ROLES.READER }),
            /both a name and an email/,
        );
    });
});

describe('pure token rotation', () => {
    before(async () => {
        reset();
        await accounts.ensureLocalAuthor(null);
    });

    it('revokes every previous author token and issues exactly one', async () => {
        const author = await accounts.getAuthorAccount();
        const old1 = await accounts.issueToken(author.id, 'old one');
        const old2 = await accounts.issueToken(author.id, 'old two');

        const { token, revoked } = await accounts.rotatePureToken();

        assert.equal(revoked, 2);
        assert.equal(await accounts.resolveToken(old1.token), null);
        assert.equal(await accounts.resolveToken(old2.token), null);
        assert.equal((await accounts.resolveToken(token))?.account.id, author.id);
    });

    it('does not touch anyone else', async () => {
        const other = await accounts.createAccount({
            name: 'Admin', email: 'admin@example.com', role: ROLES.ADMIN,
        });
        const theirs = await accounts.issueToken(other.id, 'admin token');

        await accounts.rotatePureToken();

        assert.equal((await accounts.resolveToken(theirs.token))?.account.id, other.id);
    });

    it('re-adopts the local apiToken after a rotation revoked it', async () => {
        // A desktop install would otherwise be bricked by a rotation: config.json still holds
        // the old token, Electron owns that field, and the API cannot rewrite it.
        await accounts.ensureLocalAuthor('desktop-token-xyz');
        assert.ok(await accounts.resolveToken('desktop-token-xyz'));

        await accounts.rotatePureToken();
        assert.equal(await accounts.resolveToken('desktop-token-xyz'), null);

        await accounts.ensureLocalAuthor('desktop-token-xyz');
        assert.ok(
            await accounts.resolveToken('desktop-token-xyz'),
            'restarting the desktop app must restore its own access',
        );
    });
});

describe('permission table', () => {
    it('gives readers reads and admins writes', () => {
        assert.equal(requiredRole('documents', 'GET', '/list'), ROLES.READER);
        assert.equal(requiredRole('documents', 'POST', '/folder'), ROLES.ADMIN);
        assert.equal(requiredRole('documents', 'DELETE', '/'), ROLES.ADMIN);
    });

    it('lets a collaborator annotate but not create', () => {
        // A collaborator's whole job is annotation, and every annotation — highlight, tag,
        // card — is a sidecar write. Without PUT /metadata they could do nothing at all.
        assert.equal(requiredRole('documents', 'PUT', '/metadata'), ROLES.COLLABORATOR);
        assert.equal(requiredRole('highlights', 'POST', '/'), ROLES.COLLABORATOR);
        assert.equal(requiredRole('documents', 'PUT', '/file'), ROLES.ADMIN);
        assert.equal(requiredRole('subscriptions', 'POST', '/import'), ROLES.ADMIN);
    });

    it('matches a star in the middle of a pattern against one segment', () => {
        assert.equal(
            requiredRole('flashcards', 'POST', '/abc123/flags/mouthful/dismiss'),
            ROLES.READER,
        );
        assert.equal(requiredRole('flashcards', 'POST', '/'), ROLES.ADMIN);
        assert.equal(requiredRole('flashcards', 'DELETE', '/abc123'), ROLES.ADMIN);
    });

    it('keeps destructive history operations with the owner', () => {
        assert.equal(requiredRole('seal', 'GET', '/log'), ROLES.ADMIN);
        assert.equal(requiredRole('seal', 'POST', '/rollback'), ROLES.AUTHOR);
        assert.equal(requiredRole('doctor', 'GET', '/check'), ROLES.ADMIN);
        assert.equal(requiredRole('doctor', 'POST', '/rebuild'), ROLES.AUTHOR);
    });

    it('opens the vault handshake but nothing else on that router', () => {
        // A client has to be able to ask what it just connected to.
        assert.equal(requiredRole('vault', 'GET', '/'), ROLES.READER);
        assert.equal(requiredRole('vault', 'POST', '/switch'), ROLES.AUTHOR);
        assert.equal(requiredRole('vault', 'GET', '/list'), ROLES.AUTHOR);
    });

    it('fails closed on a mount nobody declared', () => {
        // This is the property that matters most. A router added to api.js and forgotten
        // here must become unreachable, not universally reachable.
        assert.equal(requiredRole('a-router-that-does-not-exist', 'GET', '/'), ROLES.AUTHOR);
        assert.equal(requiredRole(undefined, 'GET', '/'), ROLES.AUTHOR);
    });

    it('covers every router mounted in api.js', async () => {
        const { ROUTERS } = await import('../src/api/api.js');
        const missing = Object.keys(ROUTERS).filter((mount) => !PERMISSIONS[mount]);
        assert.deepEqual(missing, [], 'these mounts have no rule and would be author-only');

        const stale = Object.keys(PERMISSIONS).filter((mount) => !ROUTERS[mount]);
        assert.deepEqual(stale, [], 'these rules name routers that are not mounted');
    });

    it('ends every mount with a catch-all, so no request falls off the end', () => {
        for (const [mount, rules] of Object.entries(PERMISSIONS)) {
            const [method, pattern] = rules[rules.length - 1];
            assert.equal(`${method} ${pattern}`, '* *', `${mount} has no catch-all rule`);
        }
    });
});
