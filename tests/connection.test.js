/**
 * Where the renderer is pointed, and — the reason this file exists — how it gets back.
 *
 * The bug: connect to a Flashback Server, have it be misconfigured or unreachable, and the
 * app could not return to a local vault. Clicking one switched the local API's database and
 * then reported the remote again, so nothing re-pointed. Restarting the app was the only way
 * out, because the flag lived in memory in the main process.
 *
 * Pure — no Electron, no SQLite, no HTTP. `createConnectionState` takes its three
 * dependencies as arguments precisely so this can run under plain `node --test`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionState } from '../src/electron/connection.js';
import { unusableUrlReason } from '../src/shared/remoteUrl.js';

const LOCAL_A = { id: 'vault-a', name: 'Personal' };
const LOCAL_B = { id: 'vault-b', name: 'Work' };

/** A fake install: two local vaults and one registered remote. */
function makeHost() {
    const config = {
        vaults: [LOCAL_A, LOCAL_B],
        activeVaultId: LOCAL_A.id,
        vaultName: LOCAL_A.name,
        host: 'localhost',
        port: 50500,
        apiToken: 'local-token',
    };
    const remotes = {
        'remote-1': { kind: 'remote', id: 'remote-1', label: 'Study Group', url: 'https://study.example.com', token: 'remote-token' },
    };
    return {
        config,
        remotes,
        /** Stands in for the API having switched its open vault. */
        setActiveVault(id) {
            config.activeVaultId = id;
            config.vaultName = [LOCAL_A, LOCAL_B].find((v) => v.id === id)?.name ?? null;
        },
        state: createConnectionState({
            readConfig: () => config,
            connectionForRemote: (id) => remotes[id] ?? null,
            apiBaseUrl: (c) => `http://${c.host}:${c.port}`,
        }),
    };
}

describe('active connection', () => {
    let host;
    beforeEach(() => { host = makeHost(); });

    it('starts on the local vault the config says is active', () => {
        const c = host.state.current();
        assert.equal(c.kind, 'local');
        assert.equal(c.id, LOCAL_A.id);
        assert.equal(c.label, 'Personal');
        assert.equal(c.url, 'http://localhost:50500');
        assert.equal(c.token, 'local-token');
    });

    it('points at a remote once one is chosen', () => {
        const c = host.state.useRemote('remote-1');
        assert.equal(c.kind, 'remote');
        assert.equal(c.id, 'remote-1');
        assert.equal(c.token, 'remote-token');
    });

    // ── The bug ──────────────────────────────────────────────────────────────
    //
    // This is the whole milestone in one test: after the API has switched to another local
    // vault, the connection MUST be local. It reported the remote, so the renderer kept
    // talking to a server the user was trying to leave.
    it('returns to local after the API switches vault while on a remote', () => {
        host.state.useRemote('remote-1');
        assert.equal(host.state.current().kind, 'remote', 'precondition: on the remote');

        // What the switch-vault handler does: the API confirms, then we go local.
        host.setActiveVault(LOCAL_B.id);
        host.state.useLocalVault();

        const c = host.state.current();
        assert.equal(c.kind, 'local', 'the app must be pointed at the local API again');
        assert.equal(c.id, LOCAL_B.id, 'and at the vault that was just opened');
        assert.equal(c.label, 'Work');
        assert.equal(c.token, 'local-token', 'with the LOCAL token, not the remote one');
        assert.equal(host.state.remoteId, null, 'nothing left pointing at the remote');
    });

    it('returns to local even when the remote is still perfectly reachable', () => {
        // Reachability is irrelevant: leaving is a decision, not a failure. The old code
        // only ever left a remote that had been deleted from the registry.
        host.state.useRemote('remote-1');
        host.state.useLocalVault();
        assert.equal(host.state.current().kind, 'local');
    });

    it('leaving is idempotent', () => {
        host.state.useLocalVault();
        host.state.useLocalVault();
        assert.equal(host.state.current().kind, 'local');
        assert.equal(host.state.remoteId, null);
    });

    it('a misconfigured remote still resolves, so the way back must be deliberate', () => {
        // `connectionForRemote` reads the registry and never the network — an unreachable
        // server looks exactly like a healthy one from here. Nothing will time out and send
        // the user home, which is why useLocalVault() has to be reachable from the UI.
        host.state.useRemote('remote-1');
        assert.equal(host.state.current().kind, 'remote', 'no reachability check happens here');
        assert.equal(host.state.current().url, 'https://study.example.com');

        host.state.useLocalVault();
        assert.equal(host.state.current().kind, 'local');
    });

    it('falls back to local when the remote is removed from the registry', () => {
        host.state.useRemote('remote-1');
        delete host.remotes['remote-1'];

        assert.equal(host.state.current().kind, 'local', 'a deleted remote cannot stay active');
        assert.equal(host.state.remoteId, null, 'and the flag is cleared, not left dangling');
    });

    it('reports the vault the API moved to, without being told', () => {
        // The connection reads config.json every time rather than caching, so a switch made
        // anywhere is reflected on the next broadcast.
        host.setActiveVault(LOCAL_B.id);
        assert.equal(host.state.current().id, LOCAL_B.id);
    });
});

// A remote URL has to be reachable by the RENDERER, and the handshake that vets it runs in
// the main process. Two HTTP stacks, and they disagree about exactly one thing.
describe('remote URL usability', () => {
    it('refuses the IPv4 unspecified address', () => {
        const why = unusableUrlReason('http://0.0.0.0:50501');
        assert.match(why, /LISTENS on/, 'and says why, since the server prints this very string');
    });

    it('refuses the IPv6 unspecified address, bracketed or not', () => {
        assert.ok(unusableUrlReason('http://[::]:50501'));
        assert.ok(unusableUrlReason('http://[0000:0000:0000:0000:0000:0000:0000:0000]:50501'));
    });

    it('refuses something that is not a URL', () => {
        assert.match(unusableUrlReason('not a url'), /not a valid URL/);
    });

    it('allows the addresses people actually connect to', () => {
        for (const url of [
            'http://localhost:50501',
            'http://127.0.0.1:50501',
            'http://192.168.1.40:50501',
            'https://flashback.example.com',
            'https://flashback.example.com:8443',
            'http://[::1]:50501',
        ]) {
            assert.equal(unusableUrlReason(url), null, `${url} should be usable`);
        }
    });

    it('does not mistake a host that merely starts with a zero', () => {
        assert.equal(unusableUrlReason('http://0.0.0.0.example.com:50501'), null);
    });
});
