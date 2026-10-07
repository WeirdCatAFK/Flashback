/**
 * Who you are on the vault you are currently connected to, and what that lets you do.
 *
 * If the identity call fails we do NOT fall back to the Author. A server that answered 401 or
 * fell over must not leave the app showing destructive controls. `role` stays null, every
 * capability answers false, and `error` is set so the Server view can say why rather than
 * leaving someone staring at an app that has quietly lost half its buttons.
 */

import { useEffect, useMemo, useState } from "react";
import { getEffectiveIdentity } from "./api/identity.js";
import { SessionContext, buildSessionValue } from "./utils/sessionContext.js";

/**
 * @param {{connectionId?: number, children: React.ReactNode}} props
 *   `connectionId` re-runs the fetch when the app is pointed somewhere else. App.jsx already
 *   remounts its tree on that key, so this is belt and braces for any caller that does not.
 */
export function SessionProvider({ connectionId, children }) {
  const [state, setState] = useState({
    account: null,
    identity: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    setState((s) => ({ ...s, loading: true, error: null }));

    const attempt = (remaining) => {
      getEffectiveIdentity()
        .then((data) => {
          if (cancelled) return;
          setState({
            account: data?.account ?? null,
            identity: data
              ? { name: data.name, email: data.email, source: data.source }
              : null,
            loading: false,
            error: null,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          const transient =
            remaining > 0 && !/\b401\b|unauthor/i.test(err?.message ?? "");
          if (transient) {
            timer = setTimeout(() => attempt(remaining - 1), 1000);
            return;
          }
          setState({
            account: null,
            identity: null,
            loading: false,
            error: err?.message || String(err),
          });
        });
    };
    attempt(5);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [connectionId]);

  const value = useMemo(() => buildSessionValue(state), [state]);

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
