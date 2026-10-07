/**
 * Role names and the one sentence a disabled control owes the person looking at it.
 *
 * `shared/roles.js` is the ladder and the capability map; it is imported by the API and by
 * Electron main, so it holds no UI strings and knows nothing about translation. This is the
 * renderer's side of that: English keys resolved at render, exactly like `navLabels()` in
 * App.jsx — a module-level constant would keep the old language after a switch.
 *
 * Kept out of `RoleBadge.jsx` so that file exports exactly one component and Fast Refresh
 * keeps working, and out of `sessionContext.js` so the session layer stays free of copy.
 */

import { CAPABILITIES, ROLES } from '../../shared/roles.js';

/** @param {(s: string) => string} t @param {string} role */
export function roleLabel(t, role) {
    switch (role) {
        case ROLES.AUTHOR:       return t('Author');
        case ROLES.ADMIN:        return t('Admin');
        case ROLES.COLLABORATOR: return t('Collaborator');
        case ROLES.READER:       return t('Reader');
        default:                 return null;
    }
}

/** Why a control is disabled: names the role required so the user knows, not just that they can't. */
export function capabilityHint(t, capability) {
    const minimum = CAPABILITIES[capability]?.minimum;
    const label = roleLabel(t, minimum);
    if (!label) return null;
    return t('Requires the {role} role on this server.', { role: label });
}

/**
 * The words the Stats and Graph person picker uses. A function of `t`, called at render, for
 * the same reason as `roleLabel` above: nothing here may be evaluated at import time.
 *
 * @param {(s: string, vars?: object) => string} t
 */
export function progressScopeLabels(t) {
    return {
        you: t('You'),
        pickerLabel: t('Progress of'),
        viewing: (name) => t("Viewing {name}'s progress", { name }),
    };
}
