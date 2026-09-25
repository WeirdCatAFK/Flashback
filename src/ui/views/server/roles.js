/**
 * Role words for Server Management, as functions of `t` so a language switch re-renders
 * them; the role ids and the ladder come from src/shared/roles.js.
 *
 * Sentences that name a role ("an Admin", "a Reader") are one key per role rather than a
 * sentence with the role pasted in: the article agrees with the role in English, and with
 * its gender or case in other languages, which a translator can only get right whole.
 */

import { ROLES, ROLE_ORDER } from '../../../shared/roles.js';

export const roleLabels = (t) => ({
  [ROLES.READER]: t('Reader'),
  [ROLES.COLLABORATOR]: t('Collaborator'),
  [ROLES.ADMIN]: t('Admin'),
  [ROLES.AUTHOR]: t('Author'),
});

export const roleBlurbs = (t) => ({
  [ROLES.READER]: t('Studies the vault. Progress is yours alone; you cannot change the material.'),
  [ROLES.COLLABORATOR]: t('Annotates documents that already exist: highlights, tags and cards. No new documents, no imports.'),
  [ROLES.ADMIN]: t('Runs the vault: creates and imports documents, and manages who has access.'),
  [ROLES.AUTHOR]: t('Owns the files. Can roll back history and rebuild the index. Exactly one per server.'),
});

/** "You're signed in as {name}, a Reader." — the lede's first sentence. */
export const signedInAs = (t, role) => ({
  [ROLES.READER]: t('You’re signed in as {name}, a Reader.'),
  [ROLES.COLLABORATOR]: t('You’re signed in as {name}, a Collaborator.'),
  [ROLES.ADMIN]: t('You’re signed in as {name}, an Admin.'),
  [ROLES.AUTHOR]: t('You’re signed in as {name}, the Author.'),
}[role] ?? t('You’re signed in as {name}.'));

/** The line after a role change. */
export const nowRole = (t, role, name) => ({
  [ROLES.READER]: t('{name} is now a Reader.', { name }),
  [ROLES.COLLABORATOR]: t('{name} is now a Collaborator.', { name }),
  [ROLES.ADMIN]: t('{name} is now an Admin.', { name }),
}[role] ?? '');

/** The token panel's title after adding someone. */
export const addedAs = (t, role, name) => ({
  [ROLES.READER]: t('{name} is added as a Reader. This is their token.', { name }),
  [ROLES.COLLABORATOR]: t('{name} is added as a Collaborator. This is their token.', { name }),
  [ROLES.ADMIN]: t('{name} is added as an Admin. This is their token.', { name }),
}[role] ?? '');

/** "12 Mar 2026" in the interface language; a dash when there is no date. */
export const fmtDate = (iso, locale) => (iso
  ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

/**
 * Whether `role` may grant `target` — and, by the same ceiling, change, deactivate or issue a
 * token for an account holding it: the Author anything but Author, an admin only Reader
 * (the API's `grantCeiling` in routes/accounts.js).
 */
export const grantable = (role, target) => (role === ROLES.AUTHOR ? target !== ROLES.AUTHOR : target === ROLES.READER);

/** The roles `role` may hand out, lowest first. */
export const grantableRoles = (role) => ROLE_ORDER.filter((r) => grantable(role, r));
