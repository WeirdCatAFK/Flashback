import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('identity');
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

function writeConfig(extra = {}) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...BASE_CONFIG, ...extra }, null, 2));
    config.reload();
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(BASE_CONFIG, null, 2));

const config = await import('../../src/api/access/primitives/config.js');
const { identityError, defaultIdentityFrom } = await import('../../src/shared/identity.js');
const { openVault, switchVault } = await import('../../src/api/vaultSession.js');
const { closeDatabase } = await import('../../src/api/access/primitives/database.js');
const Documents = await import('../../src/api/access/modules/documents.js');
const { sealTools, sealEmitter } = await import('../../src/api/seal/seal.js');


after(() => {
    closeDatabase();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
});

describe('identity resolution', () => {
    beforeEach(() => { writeConfig(); });

    it('falls back to the OS account when nothing is set', () => {
        const id = config.getIdentity();
        assert.equal(id.source, 'default');
        assert.ok(id.name, 'a default identity always has a name');
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

        await Documents.createFile('legacy.md', '');
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
        await Documents.createFile('stamped.md', '');
        const sidecar = JSON.parse(
            fs.readFileSync(path.join(config.getWorkspacePath(), 'stamped.md.flashback'), 'utf-8'),
        );
        assert.equal(sidecar.createdBy, 'Daniel <daniel@example.com>');
    });

    it('never rewrites an existing createdBy — the no-migration claim', async () => {
        await Documents.updateFile('legacy.md', '# edited');

        const after = JSON.parse(fs.readFileSync(legacySidecarPath, 'utf-8'));
        assert.equal(after.createdBy, 'alpha', 'a vault-name stamp must survive untouched');
        assert.deepEqual(
            { createdBy: after.createdBy, createdAt: after.createdAt, globalHash: after.globalHash },
            legacyProvenance,
        );
    });

    it('authors a Seal commit as the identity, not as the vault', async () => {
        await Documents.createFile('committed.md', '');
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
        assert.equal(config.getAuthorString(), 'D. Pineda <d@acme.test>');

        await Documents.createFile('in-beta.md', '');
        const sidecar = JSON.parse(
            fs.readFileSync(path.join(config.getWorkspacePath(), 'in-beta.md.flashback'), 'utf-8'),
        );
        assert.equal(sidecar.createdBy, 'D. Pineda <d@acme.test>');

        const back = await switchVault(ALPHA);
        assert.ok(back.ok, back.error);
        assert.equal(config.getAuthorString(), 'Daniel <daniel@example.com>');
    });
});
