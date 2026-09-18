/**
 * Role names and blurbs for the Server view, as functions of `t` so a language
 * switch re-renders them; the role ids come from src/shared/roles.js.
 */

import { ROLES } from '../../../shared/roles.js';

export const roleLabels = (t) => ({
  [ROLES.READER]: t('Reader'),
  [ROLES.COLLABORATOR]: t('Collaborator'),
  [ROLES.ADMIN]: t('Admin'),
  [ROLES.AUTHOR]: t('Author'),
});

export const roleBlurbs = (t) => ({
  [ROLES.READER]: t('Studies the vault. Progress is yours alone; you cannot change the material.'),
  [ROLES.COLLABORATOR]: t('Annotates documents that already exist — highlights, tags and cards. No new documents, no imports.'),
  [ROLES.ADMIN]: t('Runs the vault: creates and imports documents, and manages who has access.'),
  [ROLES.AUTHOR]: t('Owns the files. Can roll back history and rebuild the index. Exactly one per server.'),
});

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

/** Which roles the caller may grant: the Author anything but Author, an admin only Reader. */
export const grantable = (role, target) => (role === ROLES.AUTHOR ? target !== ROLES.AUTHOR : target === ROLES.READER);
