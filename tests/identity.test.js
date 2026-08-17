/**
 * Local user identity — who work is stamped as.
 *
 * Two things used to record the *vault name* where they meant to record a person: a new
 * sidecar's `createdBy` and every Seal commit's author. Both now read a git-style identity
 * with a per-vault override, and these tests pin the three things that can go wrong with
 * that: the precedence rule, the format of the string that reaches disk, and — the one
 * that would be expensive — that no existing file is rewritten by any of it.
 *
 * Run: node --test tests/identity.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.join(process.cwd(), 'data_test_identity');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const CONFIG_PATH = path.join(ROOT, 'config.json');
const ALPHA = { id: 'id-alpha', name: 'alpha', isCustomPath: false, customPath: '' };
const BETA = { id: 'id-beta', name: 'beta', isCustomPath: false, customPath: '' };

const BASE_CONFIG = {
    port: 0, logFormat: 'dev', host: 'localhost', isLocalhost: true,
    isCustomPath: false, customPath: '', vaultName: 'alpha',
    activeVaultId: ALPHA.id,
    vaults: [ALPHA, BETA],
};

/** Rewrites config.json and drops the module cache, the way an IPC write + reload would. */
function writeConfig(extra = {}) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...BASE_CONFIG, ...extra }, null, 2));
    config.reload();
}

// Written before the imports below, because config.js resolves its paths at module load.
fs.writeFileSync(CONFIG_PATH, JSON.stringify(BASE_CONFIG, null, 2));

const config = await import('../src/api/access/primitives/config.js');
const { identityError, defaultIdentityFrom } = await import('../src/shared/identity.js');
const { openVault, switchVault } = await import('../src/api/vaultSession.js');
const { closeDatabase } = await import('../src/api/access/primitives/database.js');
const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { sealTools, sealEmitter } = await import('../src/api/seal/seal.js');

const docs = new Documents();

after(() => {
    closeDatabase();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* Windows handle lag */ }
});

describe('identity resolution', () => {
    beforeEach(() => { writeConfig(); });

    it('falls back to the OS account when nothing is set', () => {
        const id = config.getIdentity();
        assert.equal(id.source, 'default');
        assert.ok(id.name, 'a default identity always has a name');
        // The .local domain is what marks it a placeholder rather than a reachable address.
        assert.match(id.email, /@flashback\.local$/);
        assert.ok(id.email.startsWith(
            os.userInfo().username.replace(/[\s@<>]/g, '').toLowerCase() || 'flashback',
        ));
    });

    it('prefers the global identity over the derived default', () => {
        writeConfig({ user: { name: 'Daniel', email: 'daniel@example.com' } });
        assert.deepEqual(config.getIdentity(), {
            name: 'Daniel', email: 'daniel@example.com', source: 'global',
        });
    });

    it('prefers this vault’s override over the global identity', () => {
        writeConfig({
            user: {
                name: 'Daniel', email: 'daniel@example.com',
                perVault: { [ALPHA.id]: { name: 'D. Pineda', email: 'd@acme.test' } },
            },
        });
        assert.deepEqual(config.getIdentity(), {
            name: 'D. Pineda', email: 'd@acme.test', source: 'vault',
        });
    });

    it('ignores an override belonging to a different vault', () => {
        writeConfig({
            user: {
                name: 'Daniel', email: 'daniel@example.com',
                perVault: { [BETA.id]: { name: 'D. Pineda', email: 'd@acme.test' } },
            },
        });
        assert.equal(config.getIdentity().source, 'global');
    });

    it('treats a half-filled identity as not set, rather than half-applying it', () => {
        // A name with no address cannot produce an author line at all, so falling through
        // is the only sane reading — the alternative is `Daniel <>`.
        writeConfig({ user: { name: 'Daniel', email: '   ' } });
        assert.equal(config.getIdentity().source, 'default');

        writeConfig({
            user: {
                name: 'Daniel', email: 'daniel@example.com',
                perVault: { [ALPHA.id]: { name: 'D. Pineda' } },
            },
        });
        assert.equal(config.getIdentity().source, 'global');
    });

    it('resolves without an activeVaultId, which is what an older config has', () => {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({
            port: 0, logFormat: 'dev', host: 'localhost', isLocalhost: true,
            isCustomPath: false, customPath: '', vaultName: 'alpha',
            user: { name: 'Daniel', email: 'daniel@example.com' },
        }, null, 2));
        config.reload();
        assert.equal(config.getIdentity().source, 'global');
    });

    it('renders the author string as a git author line', () => {
        writeConfig({ user: { name: 'Daniel', email: 'daniel@example.com' } });
        assert.equal(config.getAuthorString(), 'Daniel <daniel@example.com>');
    });
});

describe('identity validation', () => {
    it('accepts an ordinary name and address', () => {
        assert.equal(identityError({ name: 'Daniel', email: 'daniel@example.com' }), null);
    });

    it('rejects the characters that would break a git author line', () => {
        // `Name <email>` is assembled by concatenation, so an angle bracket in either half
        // produces a malformed commit object rather than a malformed-looking name.
        assert.equal(identityError({ name: 'Dan <x>', email: 'a@b.co' }).code, 'invalid-chars');
        assert.equal(identityError({ name: 'Dan\nx', email: 'a@b.co' }).code, 'invalid-chars');
        assert.equal(identityError({ name: 'Dan', email: 'a b@c.co' }).code, 'invalid-chars');
    });

    it('rejects an empty half and reports which one', () => {
        assert.deepEqual(identityError({ name: '', email: 'a@b.co' }),
            { field: 'name', code: 'required' });
        assert.deepEqual(identityError({ name: 'Dan', email: '' }),
            { field: 'email', code: 'required' });
    });

    it('catches a name typed into the email field', () => {
        assert.equal(identityError({ name: 'Dan', email: 'Daniel' }).code, 'not-an-address');
    });
});

describe('the derived default', () => {
    // Shared between the API's resolver and the setup wizard's pre-fill, so what the wizard
    // offers is the same string that would be stamped if the step were skipped. It is only
    // useful if it always produces something an author line can hold.
    it('turns an OS account name into a usable identity', () => {
        assert.deepEqual(defaultIdentityFrom('Daniel'),
            { name: 'Daniel', email: 'daniel@flashback.local' });
    });

    it('strips what would break the address', () => {
        assert.equal(defaultIdentityFrom('Da ni el').email, 'daniel@flashback.local');
        assert.equal(defaultIdentityFrom('a@b<c>').email, 'abc@flashback.local');
    });

    it('always yields something valid, even given nothing', () => {
        for (const input of ['', '   ', null, undefined, '@<> ']) {
            const derived = defaultIdentityFrom(input);
            assert.equal(identityError(derived), null,
                `defaultIdentityFrom(${JSON.stringify(input)}) must pass validation`);
        }
    });
});

describe('what reaches disk', () => {
    let legacySidecarPath;
    let legacyProvenance;

    before(async () => {
        writeConfig({ user: { name: 'Daniel', email: 'daniel@example.com' } });
        assert.ok(await openVault());

        // A file written BEFORE any of this, carrying the old vault-name stamp.
        await docs.createFile('legacy.md', '');
        legacySidecarPath = path.join(config.getWorkspacePath(), 'legacy.md.flashback');
        const legacy = JSON.parse(fs.readFileSync(legacySidecarPath, 'utf-8'));
        legacy.createdBy = 'alpha';
        fs.writeFileSync(legacySidecarPath, JSON.stringify(legacy, null, 2));
        legacyProvenance = {
            createdBy: legacy.createdBy,
            createdAt: legacy.createdAt,
            globalHash: legacy.globalHash,
        };
    });

    it('stamps a new sidecar with the git author string', async () => {
        await docs.createFile('stamped.md', '');
        const sidecar = JSON.parse(
            fs.readFileSync(path.join(config.getWorkspacePath(), 'stamped.md.flashback'), 'utf-8'),
        );
        assert.equal(sidecar.createdBy, 'Daniel <daniel@example.com>');
    });

    it('never rewrites an existing createdBy — the no-migration claim', async () => {
        // Every write site is `createdBy || …`, so provenance is set once at creation and a
        // file that predates identity goes on saying what it said. Scoped to the provenance
        // fields rather than the whole file on purpose: an edit legitimately rewrites other
        // parts of the sidecar (`encoding` is re-detected), and asserting bytes here would
        // fail for reasons that have nothing to do with authorship.
        await docs.updateFile('legacy.md', '# edited');

        const after = JSON.parse(fs.readFileSync(legacySidecarPath, 'utf-8'));
        assert.equal(after.createdBy, 'alpha', 'a vault-name stamp must survive untouched');
        assert.deepEqual(
            { createdBy: after.createdBy, createdAt: after.createdAt, globalHash: after.globalHash },
            legacyProvenance,
        );
    });

    it('authors a Seal commit as the identity, not as the vault', async () => {
        await docs.createFile('committed.md', '');
        await sealEmitter.flushEdits();

        const [head] = await sealTools.log(1);
        assert.equal(head.commit.author.name, 'Daniel');
        assert.equal(head.commit.author.email, 'daniel@example.com');
    });

    it('follows a vault switch, since the override is per vault', async () => {
        writeConfig({
            user: {
                name: 'Daniel', email: 'daniel@example.com',
                perVault: { [BETA.id]: { name: 'D. Pineda', email: 'd@acme.test' } },
            },
        });

        assert.equal(config.getAuthorString(), 'Daniel <daniel@example.com>');

        const switched = await switchVault(BETA);
        assert.ok(switched.ok, switched.error);
        // reload() dropping the config cache is the only mechanism making this per-vault.
        assert.equal(config.getAuthorString(), 'D. Pineda <d@acme.test>');

        await docs.createFile('in-beta.md', '');
        const sidecar = JSON.parse(
            fs.readFileSync(path.join(config.getWorkspacePath(), 'in-beta.md.flashback'), 'utf-8'),
        );
        assert.equal(sidecar.createdBy, 'D. Pineda <d@acme.test>');

        const back = await switchVault(ALPHA);
        assert.ok(back.ok, back.error);
        assert.equal(config.getAuthorString(), 'Daniel <daniel@example.com>');
    });
});
