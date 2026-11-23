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

export const signedInAs = (t, role) => ({
  [ROLES.READER]: t('You’re signed in as {name}, a Reader.'),
  [ROLES.COLLABORATOR]: t('You’re signed in as {name}, a Collaborator.'),
  [ROLES.ADMIN]: t('You’re signed in as {name}, an Admin.'),
  [ROLES.AUTHOR]: t('You’re signed in as {name}, the Author.'),
}[role] ?? t('You’re signed in as {name}.'));

export const nowRole = (t, role, name) => ({
  [ROLES.READER]: t('{name} is now a Reader.', { name }),
  [ROLES.COLLABORATOR]: t('{name} is now a Collaborator.', { name }),
  [ROLES.ADMIN]: t('{name} is now an Admin.', { name }),
}[role] ?? '');

export const addedAs = (t, role, name) => ({
  [ROLES.READER]: t('{name} is added as a Reader. This is their token.', { name }),
  [ROLES.COLLABORATOR]: t('{name} is added as a Collaborator. This is their token.', { name }),
  [ROLES.ADMIN]: t('{name} is added as an Admin. This is their token.', { name }),
}[role] ?? '');

export const fmtDate = (iso, locale) => (iso
  ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

export const grantable = (role, target) => (role === ROLES.AUTHOR ? target !== ROLES.AUTHOR : target === ROLES.READER);

export const grantableRoles = (role) => ROLE_ORDER.filter((r) => grantable(role, r));
