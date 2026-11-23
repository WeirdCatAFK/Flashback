import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, ROLES, ROLE_ORDER, can, atLeast } from '../src/shared/roles.js';
import { PERMISSIONS, requiredRole } from '../src/api/auth/permissions.js';

describe('UI capabilities match the API permission table', () => {

    describe('every capability is well formed', () => {
        it('names a real role and at least one request it stands for', () => {
            for (const [name, entry] of Object.entries(CAPABILITIES)) {
                assert.ok(ROLE_ORDER.includes(entry.minimum),
                    `${name}: "${entry.minimum}" is not a role`);
                assert.ok(Array.isArray(entry.guards) && entry.guards.length > 0,
                    `${name}: has no guards, so nothing verifies it`);
                for (const guard of entry.guards) {
                    assert.equal(guard.length, 3,
                        `${name}: a guard is [mount, method, path]`);
                }
            }
        });

        it('only names mounts the API actually serves', () => {
            for (const [name, entry] of Object.entries(CAPABILITIES)) {
                for (const [mount] of entry.guards) {
                    assert.ok(mount in PERMISSIONS,
                        `${name}: "${mount}" is not a mount in PERMISSIONS`);
                }
            }
        });
    });


    describe('each capability agrees with the guard', () => {
        for (const [name, entry] of Object.entries(CAPABILITIES)) {
            it(`${name} → ${entry.minimum}`, () => {
                for (const [mount, method, path] of entry.guards) {
                    const actual = requiredRole(mount, method, path);
                    assert.equal(actual, entry.minimum,
                        `${name} claims ${entry.minimum}, but ${method} /api/${mount}${path} `
                        + `requires ${actual}. Either the capability is wrong, or the route moved `
                        + `and the UI is now lying to somebody.`);
                }
            });
        }
    });


    describe('can() and the guard reach the same verdict', () => {
        it('agrees for every role against every capability', () => {
            for (const role of ROLE_ORDER) {
                for (const [name, entry] of Object.entries(CAPABILITIES)) {
                    const uiSaysYes = can(role, name);
                    for (const [mount, method, path] of entry.guards) {
                        const serverSaysYes = atLeast(role, requiredRole(mount, method, path));
                        assert.equal(uiSaysYes, serverSaysYes,
                            `${role}: UI ${uiSaysYes ? 'shows' : 'hides'} ${name}, but the server `
                            + `${serverSaysYes ? 'allows' : 'refuses'} ${method} /api/${mount}${path}`);
                    }
                }
            }
        });

        it('refuses an unknown capability rather than defaulting to allowed', () => {
            assert.equal(can(ROLES.AUTHOR, 'no-such-capability'), false);
        });

        it('refuses an unknown role, so a corrupt account row hides controls', () => {
            assert.equal(can('superuser', 'readVault'), false);
            assert.equal(can(null, 'readVault'), false);
        });
    });


    describe('the map covers the whole ladder', () => {
        it('has at least one capability at every role', () => {
            const minimums = new Set(Object.values(CAPABILITIES).map((c) => c.minimum));
            for (const role of ROLE_ORDER) {
                assert.ok(minimums.has(role),
                    `no capability requires ${role} — either the map is incomplete or the role `
                    + `has no meaning in the UI`);
            }
        });

        it('gives a reader something and an author everything', () => {
            const names = Object.keys(CAPABILITIES);
            const readerCan = names.filter((n) => can(ROLES.READER, n));
            const authorCan = names.filter((n) => can(ROLES.AUTHOR, n));
            assert.ok(readerCan.length > 0, 'a reader must be able to do something');
            assert.equal(authorCan.length, names.length, 'the author is not restricted by role');
        });
    });
});
