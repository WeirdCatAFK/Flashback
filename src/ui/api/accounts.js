import { request } from './client.js';

/**
 * `/api/accounts` — who may reach the connected server, and as what.
 *
 * Every function here needs Admin, and `rotatePureToken` needs Author. The Server view hides
 * the controls that call them, so a 403 from this module means the UI and the guard have
 * drifted — which `tests/capabilities.test.js` exists to prevent.
 *
 * **A plaintext token is returned exactly once**, by `issueToken` and `rotatePureToken`, and
 * is not stored anywhere that can hand it back. Whatever calls these owns showing it to the
 * person before it is gone.
 */

/** @returns {Promise<{accounts: Array<object>, you: object}>} */
export function listAccounts() {
    return request('GET', '/api/accounts');
}

/** @param {{name: string, email: string, role: string}} account */
export function createAccount(account) {
    return request('POST', '/api/accounts', account);
}

/**
 * @param {string} id
 * @param {{role?: string, active?: boolean}} changes
 */
export function updateAccount(id, changes) {
    return request('PATCH', `/api/accounts/${encodeURIComponent(id)}`, changes);
}

/**
 * One account's study summary. Admin-only, and the only call in the app that reads a
 * schedule belonging to someone else.
 *
 * @param {string} id
 * @param {string} [algorithm]
 * @returns {Promise<{account: object, scope: string, statistics: object}>}
 */
export function getAccountProgress(id, algorithm = null) {
    const query = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : '';
    return request('GET', `/api/accounts/${encodeURIComponent(id)}/progress${query}`);
}

/**
 * Issues a token. **The plaintext is in this response and nowhere else, ever.**
 * @returns {Promise<{id: string, token: string, label: string, accountId: string, notice: string}>}
 */
export function issueToken(accountId, label = '') {
    return request('POST', `/api/accounts/${encodeURIComponent(accountId)}/tokens`, { label });
}

export function revokeToken(tokenId) {
    return request('DELETE', `/api/accounts/tokens/${encodeURIComponent(tokenId)}`);
}

/**
 * Mints a new Author token and revokes every previous one, in one operation. Author only.
 * @returns {Promise<{token: string, accountId: string, revoked: number, notice: string}>}
 */
export function rotatePureToken(label = 'Pure token') {
    return request('POST', '/api/accounts/pure-token', { label });
}
