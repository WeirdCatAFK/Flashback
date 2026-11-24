import { createContext, useContext } from 'react';
import { can as roleCan } from '../../shared/roles.js';

export const SessionContext = createContext(null);

export function useSession() {
    return useContext(SessionContext) ?? {
        account: null, identity: null, role: null,
        can: () => false, loading: false, error: null,
    };
}

export function useCan(capability) {
    return useSession().can(capability);
}

/** Returns how many tries remain after a failed identity request, or null to stop. A server that does not answer yet costs no try. */
export function triesLeft(err, remaining) {
    if (err?.status === undefined || err.status === 503) return remaining;
    if (err.status === 401 || remaining === 0) return null;
    return remaining - 1;
}

export function buildSessionValue(state) {
    const role = state.account?.role ?? null;
    return {
        ...state,
        role,
        can: (capability) => roleCan(role, capability),
    };
}
