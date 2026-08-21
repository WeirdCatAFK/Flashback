/**
 * Who you are on the vault you are currently connected to, and what that lets you do.
 *
 * ## Why this is a Context, when INTERFACE.md says server state is not
 *
 * That rule is about VAULT data — documents, cards, decks — and it stands: lifting those into
 * a provider is how a React app ends up with one god-object and no idea what refetches when.
 *
 * The caller's account is a different kind of thing. It is session identity, the sibling of
 * `connection` in `hooks/useConnection.js`: one value, fetched once, changing only when you
 * connect somewhere else. And it is needed at the leaves — the delete item inside a file-tree
 * context menu, the edit pencil on a card — so the alternative is drilling a prop through
 * Documents → tree → node → menu in most views. That trade is what this exception buys, and
 * the boundary is deliberately narrow: identity and permission, nothing else. Anything that
 * describes the vault's CONTENTS still belongs in the view that shows it.
 *
 * ## What it resolves to on a desktop install
 *
 * `GET /api/identity` returns `account` from `req.account`, which on a local vault with no
 * token is the Author (see `auth/authenticate.js`). So a normal desktop session gets
 * `role: 'author'`, every capability answers true, and nothing in the UI changes — which is
 * the property that makes this safe to add everywhere at once.
 *
 * The context object and the hooks that read it live in `sessionContext.js`, so this module
 * exports exactly one component and Fast Refresh keeps working.
 *
 * ## Failing closed, but not silently
 *
 * If the identity call fails we do NOT fall back to the Author. A server that answered 401 or
 * fell over must not leave the app showing destructive controls. `role` stays null, every
 * capability answers false, and `error` is set so the Server view can say why rather than
 * leaving someone staring at an app that has quietly lost half its buttons.
 */

import { useEffect, useMemo, useState } from 'react';
import { getEffectiveIdentity } from './api/identity.js';
import { SessionContext, buildSessionValue } from './sessionContext.js';

/**
 * @param {{connectionId?: number, children: React.ReactNode}} props
 *   `connectionId` re-runs the fetch when the app is pointed somewhere else. App.jsx already
 *   remounts its tree on that key, so this is belt and braces for any caller that does not.
 */
export function SessionProvider({ connectionId, children }) {
    const [state, setState] = useState({ account: null, identity: null, loading: true, error: null });

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        setState((s) => ({ ...s, loading: true, error: null }));

        // Retried, because this provider wraps the TITLE BAR and therefore sits outside
        // AppGate — the component whose whole job is waiting for the API to answer. Switching
        // between two local vaults restarts the database underneath us, so the first attempt
        // can easily land while nothing is listening. Without a retry that transient failure
        // would be permanent for the session: role null, every capability false, and a user
        // staring at an app that has silently lost half its controls until they switch again.
        const attempt = (remaining) => {
            getEffectiveIdentity()
                .then((data) => {
                    if (cancelled) return;
                    setState({
                        account: data?.account ?? null,
                        identity: data ? { name: data.name, email: data.email, source: data.source } : null,
                        loading: false,
                        error: null,
                    });
                })
                .catch((err) => {
                    if (cancelled) return;
                    // A 401 is an answer, not an outage: the token is wrong and retrying will
                    // not fix it. Only keep trying while the server is failing to respond.
                    const transient = remaining > 0 && !/\b401\b|unauthor/i.test(err?.message ?? '');
                    if (transient) {
                        timer = setTimeout(() => attempt(remaining - 1), 1000);
                        return;
                    }
                    // No optimistic default — see the header.
                    setState({ account: null, identity: null, loading: false, error: err?.message || String(err) });
                });
        };
        attempt(5);

        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [connectionId]);

    const value = useMemo(() => buildSessionValue(state), [state]);

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
