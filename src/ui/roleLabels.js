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

import { CAPABILITIES, ROLES } from '../shared/roles.js';

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

/**
 * Why a control is disabled rather than simply absent — the tooltip half of the hide/disable
 * rule (see INTERFACE.md). Names the role required, because "you can't do that" without a
 * reason is the thing that sends people to a support channel.
 *
 * Returns null for an unknown capability rather than a guess, so a typo shows up as a missing
 * tooltip rather than as a confident wrong sentence.
 */
export function capabilityHint(t, capability) {
    const minimum = CAPABILITIES[capability]?.minimum;
    const label = roleLabel(t, minimum);
    if (!label) return null;
    return t('Requires the {role} role on this server.', { role: label });
}
