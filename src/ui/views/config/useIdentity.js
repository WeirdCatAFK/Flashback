/**
 * Who this install stamps work as: the stored identity and this vault's override (Electron
 * main, over IPC), what the connected server would actually stamp (`/api/identity`), and
 * saving either. Refetched when the connection changes. Config holds it, so the index can
 * name who you are and the You section can edit it.
 */

import { useCallback, useEffect, useState } from 'react';
import { getEffectiveIdentity, getStoredIdentity, setIdentity, setVaultIdentity } from '../../api/identity.js';
import { useT } from '../../translations/index';

const EMPTY = { name: '', email: '' };

export default function useIdentity(connection) {
  const { t } = useT();
  const [effective, setEffective] = useState(null);
  const [global, setGlobal] = useState(EMPTY);
  const [override, setOverride] = useState(null);
  const [vaultId, setVaultId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    const [stored, live] = await Promise.all([getStoredIdentity(), getEffectiveIdentity().catch(() => null)]);
    setGlobal(stored.user ?? EMPTY);
    setOverride(stored.override);
    setVaultId(stored.activeVaultId);
    setEffective(live);
  }, []);

  useEffect(() => { refresh(); }, [refresh, connection?.id]);

  const run = async (key, fn, success) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result?.ok === false) { setError(result.error ?? t('Something went wrong.')); return; }
      setNotice(success);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  /** Turning the override on starts it from your identity; turning it off clears it at once. */
  const toggleOverride = (on) => {
    setError(null);
    setNotice(null);
    if (on) { setOverride({ ...global }); return; }
    setOverride(null);
    if (vaultId) run('clear-override', () => setVaultIdentity(vaultId, null), t('Override removed.'));
  };

  return {
    effective, global, override, vaultId, busy, error, notice,
    setGlobalField: (key, value) => { setNotice(null); setGlobal((g) => ({ ...g, [key]: value })); },
    setOverrideField: (key, value) => { setNotice(null); setOverride((o) => ({ ...o, [key]: value })); },
    toggleOverride,
    saveGlobal: () => run('save', () => setIdentity(global), t('Saved. New documents and Seal entries use it from now on.')),
    saveOverride: () => run('save-override', () => setVaultIdentity(vaultId, override), t('Saved for this vault.')),
  };
}
