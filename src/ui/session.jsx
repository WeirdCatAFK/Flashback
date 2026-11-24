import { useEffect, useMemo, useState } from "react";
import { getEffectiveIdentity } from "./api/identity.js";
import { SessionContext, buildSessionValue, triesLeft } from "./utils/sessionContext.js";

/** A failed identity request leaves the role null, so every capability is false. Never fall back to the Author. */
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
          const left = triesLeft(err, remaining);
          if (left !== null) {
            timer = setTimeout(() => attempt(left), 1000);
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
