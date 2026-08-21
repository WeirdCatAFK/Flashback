/**
 * The session context object and the hooks that read it. See `session.jsx` for the provider
 * that fills it, and for why session identity is a Context at all when INTERFACE.md says
 * server state is not.
 *
 * Split from the provider because eslint-plugin-react-refresh is right: a module that exports
 * both a component and plain functions breaks Fast Refresh for everything importing it. The
 * context lives here, with the hooks, so `session.jsx` exports exactly one component.
 */

import { createContext, useContext } from 'react';
import { can as roleCan } from '../shared/roles.js';

/** @type {import('react').Context<null | object>} */
export const SessionContext = createContext(null);

/**
 * Who you are on the connected vault, and what that lets you do.
 *
 * @returns {{account: object|null, identity: object|null, role: string|null,
 *            can: (capability: string) => boolean, loading: boolean, error: string|null}}
 *
 * Usable outside a provider — Setup renders before one exists — where it reports no role and
 * therefore no capabilities, which is the correct answer for "not connected to anything yet".
 */
export function useSession() {
    return useContext(SessionContext) ?? {
        account: null, identity: null, role: null,
        can: () => false, loading: false, error: null,
    };
}

/**
 * Just the predicate, for the common case.
 *
 *   const canEdit = useCan('editCards');
 *
 * @param {string} capability a key of CAPABILITIES in `shared/roles.js`
 */
export function useCan(capability) {
    return useSession().can(capability);
}

/** Shared by the provider so the fallback above and the real value agree in shape. */
export function buildSessionValue(state) {
    const role = state.account?.role ?? null;
    return {
        ...state,
        role,
        can: (capability) => roleCan(role, capability),
    };
}
