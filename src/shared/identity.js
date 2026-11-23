/** Characters that break a git author line `Name <email>`. */
// eslint-disable-next-line no-control-regex
export const INVALID_IDENTITY = /[<>"\x00-\x1f]/;

// eslint-disable-next-line no-control-regex
const INVALID_IDENTITY_ALL = /[<>"\x00-\x1f]/g;

export const MAX_IDENTITY_LENGTH = 128;

export function identityNameError(name) {
    const v = (name ?? '').trim();
    if (!v) return 'required';
    if (INVALID_IDENTITY.test(v)) return 'invalid-chars';
    if (v.length > MAX_IDENTITY_LENGTH) return 'too-long';
    return null;
}

export function identityEmailError(email) {
    const v = (email ?? '').trim();
    if (!v) return 'required';
    if (INVALID_IDENTITY.test(v) || /\s/.test(v)) return 'invalid-chars';
    if (v.length > MAX_IDENTITY_LENGTH) return 'too-long';
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(v)) return 'not-an-address';
    return null;
}

export const DEFAULT_EMAIL_DOMAIN = 'flashback.local';

export function defaultIdentityFrom(username) {
    const name = String(username ?? '').replace(INVALID_IDENTITY_ALL, '').trim() || 'flashback';
    const local = name.replace(/[\s@<>]/g, '').toLowerCase() || 'flashback';
    return { name, email: `${local}@${DEFAULT_EMAIL_DOMAIN}` };
}

export function identityError(identity) {
    const nameCode = identityNameError(identity?.name);
    if (nameCode) return { field: 'name', code: nameCode };
    const emailCode = identityEmailError(identity?.email);
    if (emailCode) return { field: 'email', code: emailCode };
    return null;
}
