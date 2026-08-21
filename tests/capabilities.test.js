/**
 * The renderer's capability map against the API's permission table.
 *
 * `src/shared/roles.js` names what the UI asks before drawing a control ("may this person
 * create documents?"). `src/api/auth/permissions.js` decides what the server actually allows,
 * matched per method and path. Those are two statements of the same policy, and nothing but
 * this file stops them drifting apart.
 *
 * Drift is worse than it sounds because it fails in both directions and neither is loud:
 *
 *   - too permissive → the UI offers a button that answers 403 when pressed;
 *   - too strict     → a control is hidden from someone who was allowed to use it, and they
 *                      have no way to discover that, because nothing appears at all.
 *
 * So every capability records the requests it stands for, and this runs each one through the
 * API's real `requiredRole()` — not a copy of it — and asserts the answers agree.
 *
 * Pure: no database, no HTTP, no filesystem. Like `tests/sequencing.test.js`, it runs without
 * a compiled better-sqlite3.
 *
 * Run: node --test tests/capabilities.test.js
 */

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
            // A capability pointing at a mount that does not exist would silently resolve to
            // AUTHOR through the table's fail-closed default, and the agreement check below
            // would pass while asserting nothing.
            for (const [name, entry] of Object.entries(CAPABILITIES)) {
                for (const [mount] of entry.guards) {
                    assert.ok(mount in PERMISSIONS,
                        `${name}: "${mount}" is not a mount in PERMISSIONS`);
                }
            }
        });
    });

    // --- The actual anti-drift assertion ------------------------------------

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

    // --- The property that makes the map usable at all ----------------------

    describe('can() and the guard reach the same verdict', () => {
        it('agrees for every role against every capability', () => {
            // The UI calls can(); the server calls atLeast(role, requiredRole(...)). If those
            // ever disagree, every control gated by the capability is wrong for that role.
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

    // --- Coverage: the roles that exist must each be reachable --------------

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
