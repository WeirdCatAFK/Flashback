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

export function buildSessionValue(state) {
    const role = state.account?.role ?? null;
    return {
        ...state,
        role,
        can: (capability) => roleCan(role, capability),
    };
}
