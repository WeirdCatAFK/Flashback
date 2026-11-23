import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    isPrivateAddress,
    assertFetchableUrl,
    safeFetch,
} from '../src/api/access/resources/safeFetch.js';

const PUBLIC = 'http://93.184.216.34/page';

describe('safeFetch — address classification', () => {
    it('recognizes the ranges that reach back inside', () => {
        const priv = [
            '127.0.0.1', '127.1.2.3',
            '0.0.0.0',
            '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
            '169.254.169.254',
            '100.64.0.1',
            '224.0.0.1', '255.255.255.255',
            '::1', '::', 'fd00::1', 'fe80::1',
            '::ffff:127.0.0.1',
            'not-an-ip',
        ];
        for (const ip of priv) {
            assert.equal(isPrivateAddress(ip), true, `${ip} should be treated as private`);
        }

        const pub = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700::1'];
        for (const ip of pub) {
            assert.equal(isPrivateAddress(ip), false, `${ip} should be treated as public`);
        }
    });
});

describe('safeFetch — assertFetchableUrl', () => {
    it('refuses every scheme but http and https', async () => {
        for (const url of ['file:///etc/passwd', 'data:text/html,<b>x', 'ftp://example.com/x', 'gopher://x/']) {
            await assert.rejects(() => assertFetchableUrl(url), /Only http and https/, url);
        }
    });

    it('refuses an address on a private network, by literal or by name', async () => {
        const blocked = [
            'http://127.0.0.1:8080/admin',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5:8080/',
            'http://192.168.1.1/',
            'http://[::1]:3000/',
            'http://localhost:50500/api/documents/list',
            'http://nas.local/files',
            'http://vault.internal/secrets',
        ];
        for (const url of blocked) {
            await assert.rejects(() => assertFetchableUrl(url), /private network/, url);
        }
    });

    it('carries a 400 so the API answers "your address", not "our fault"', async () => {
        await assert.rejects(
            () => assertFetchableUrl('http://169.254.169.254/'),
            (err) => err.status === 400 && err.code === 'blocked_address',
        );
    });

    it('lets an unresolvable host through, for the fetch itself to fail on', async () => {
        const url = await assertFetchableUrl('https://example.test/great-article');
        assert.equal(url.hostname, 'example.test');
    });

    it('allows a public address', async () => {
        const url = await assertFetchableUrl(PUBLIC);
        assert.equal(url.href, PUBLIC);
    });

    it('allowPrivate lifts the address check and nothing else', async () => {
        const url = await assertFetchableUrl('http://192.168.1.1/wiki', { allowPrivate: true });
        assert.equal(url.hostname, '192.168.1.1');
        await assert.rejects(
            () => assertFetchableUrl('file:///etc/passwd', { allowPrivate: true }),
            /Only http and https/,
        );
    });
});

describe('safeFetch — redirects', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    function stub(answers) {
        const asked = [];
        globalThis.fetch = async (url) => {
            asked.push(url);
            const answer = answers[url];
            if (!answer) throw new Error(`unexpected fetch of ${url}`);
            return answer;
        };
        return asked;
    }

    const redirectTo = (location) => new Response(null, { status: 302, headers: { location } });

    it('returns a non-redirect response as fetch would', async () => {
        const asked = stub({ [PUBLIC]: new Response('hello', { status: 200 }) });
        const resp = await safeFetch(PUBLIC);
        assert.equal(resp.status, 200);
        assert.equal(await resp.text(), 'hello');
        assert.deepEqual(asked, [PUBLIC]);
    });

    it('re-checks every hop: a public page may not redirect into the private network', async () => {
        const asked = stub({ [PUBLIC]: redirectTo('http://169.254.169.254/latest/meta-data/') });

        await assert.rejects(() => safeFetch(PUBLIC), /private network/);
        assert.deepEqual(asked, [PUBLIC], 'the redirect target must never be fetched');
    });

    it('follows a redirect that stays public, resolving a relative Location', async () => {
        const asked = stub({
            [PUBLIC]: redirectTo('/moved'),
            'http://93.184.216.34/moved': new Response('arrived', { status: 200 }),
        });

        const resp = await safeFetch(PUBLIC);
        assert.equal(await resp.text(), 'arrived');
        assert.deepEqual(asked, [PUBLIC, 'http://93.184.216.34/moved']);
    });

    it('stops rather than chasing a redirect loop', async () => {
        stub({
            [PUBLIC]: redirectTo('http://93.184.216.34/page'),
        });
        await assert.rejects(
            () => safeFetch(PUBLIC, {}, { maxRedirects: 2 }),
            /redirected more than 2 times/,
        );
    });
});
