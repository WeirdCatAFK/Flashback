// Local-identity rules, shared by the renderer (the Config identity section) and the
// Electron main process (the set-identity IPC), the same way vaultName.js is shared.
//
// Plain JS with no Node or Electron imports: Vite bundles it into the renderer and main
// imports it directly, so there is one definition of a legal identity.
//
// The rules are deliberately thin. This is a self-asserted name and email in git's sense —
// nothing validates that the address exists, and nothing should, because nothing
// authenticates against it. What IS checked is the small set of characters that would
// produce a malformed git author line, since `Name <email>` is assembled by concatenation
// and an angle bracket or a newline in either half breaks the commit object rather than
// the person's feelings.
//
// Returns a CODE, not a sentence: the renderer runs it through t(), main logs it.

// Angle brackets delimit the address in an author line; a newline ends the header. A
// literal quote is harmless in git but confuses enough downstream tooling to refuse.
// eslint-disable-next-line no-control-regex
export const INVALID_IDENTITY = /[<>"\x00-\x1f]/;

// eslint-disable-next-line no-control-regex
const INVALID_IDENTITY_ALL = /[<>"\x00-\x1f]/g;

export const MAX_IDENTITY_LENGTH = 128;

/**
 * @param {string} name
 * @returns {'required'|'invalid-chars'|'too-long'|null} null when usable.
 */
export function identityNameError(name) {
    const v = (name ?? '').trim();
    if (!v) return 'required';
    if (INVALID_IDENTITY.test(v)) return 'invalid-chars';
    if (v.length > MAX_IDENTITY_LENGTH) return 'too-long';
    return null;
}

/**
 * @param {string} email
 * @returns {'required'|'invalid-chars'|'too-long'|'not-an-address'|null} null when usable.
 */
export function identityEmailError(email) {
    const v = (email ?? '').trim();
    if (!v) return 'required';
    if (INVALID_IDENTITY.test(v) || /\s/.test(v)) return 'invalid-chars';
    if (v.length > MAX_IDENTITY_LENGTH) return 'too-long';
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(v)) return 'not-an-address';
    return null;
}

export const DEFAULT_EMAIL_DOMAIN = 'flashback.local';

/**
 * The identity to fall back on when the user has set none, given an OS account name.
 *
 * @param {string} username
 * @returns {{name: string, email: string}}
 */
export function defaultIdentityFrom(username) {
    const name = String(username ?? '').replace(INVALID_IDENTITY_ALL, '').trim() || 'flashback';
    const local = name.replace(/[\s@<>]/g, '').toLowerCase() || 'flashback';
    return { name, email: `${local}@${DEFAULT_EMAIL_DOMAIN}` };
}

/**
 * Validates a whole {name, email} pair.
 *
 * @param {{name?: string, email?: string}} identity
 * @returns {{field: 'name'|'email', code: string}|null} null when the pair is usable.
 */
export function identityError(identity) {
    const nameCode = identityNameError(identity?.name);
    if (nameCode) return { field: 'name', code: nameCode };
    const emailCode = identityEmailError(identity?.email);
    if (emailCode) return { field: 'email', code: emailCode };
    return null;
}
