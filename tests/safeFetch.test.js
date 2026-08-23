/**
 * safeFetch — the guard on every URL a user hands the clipper.
 *
 * Pure, like sequencing and translations: node builtins only, so this runs with no vault,
 * no SQLite binary and no network. Addresses are IP literals wherever possible so nothing
 * here depends on DNS, and the redirect tests stub `globalThis.fetch` outright — what is
 * being tested is which addresses we agree to ask for, not what any host answers.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    isPrivateAddress,
    assertFetchableUrl,
    safeFetch,
} from '../src/api/access/resources/safeFetch.js';

// A public IP literal, so assertFetchableUrl never reaches a DNS lookup.
const PUBLIC = 'http://93.184.216.34/page';

describe('safeFetch — address classification', () => {
    it('recognizes the ranges that reach back inside', () => {
        const priv = [
            '127.0.0.1', '127.1.2.3',          // loopback
            '0.0.0.0',                          // "this network"
            '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC1918
            '169.254.169.254',                  // link-local: cloud instance metadata
            '100.64.0.1',                       // CGNAT
            '224.0.0.1', '255.255.255.255',     // multicast / broadcast
            '::1', '::', 'fd00::1', 'fe80::1',  // v6 loopback, unspecified, ULA, link-local
            '::ffff:127.0.0.1',                 // a v4 loopback wearing a v6 hat
            'not-an-ip',                        // nothing can vouch for this
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

    // "Does this name point somewhere private", not "does this name exist". undici resolves
    // through the same OS resolver, so a name we cannot look up is a connection that cannot
    // be made either — refusing would buy nothing and would misreport a DNS outage as a
    // blocked address. It is also what lets the clip tests use a fixture domain.
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
        // The scheme restriction is not part of the escape hatch.
        await assert.rejects(
            () => assertFetchableUrl('file:///etc/passwd', { allowPrivate: true }),
            /Only http and https/,
        );
    });
});

describe('safeFetch — redirects', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    /** Stubs fetch with a scripted answer per requested URL, recording what was asked for. */
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
        // The whole point: the second request was never made.
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
