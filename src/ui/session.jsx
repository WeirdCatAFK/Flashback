import { useEffect, useMemo, useState } from "react";
import { getEffectiveIdentity } from "./api/identity.js";
import { SessionContext, buildSessionValue } from "./utils/sessionContext.js";

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
