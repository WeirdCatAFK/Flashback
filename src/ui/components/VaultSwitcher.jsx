/**
 * VaultSwitcher — the vault name in the title bar, and the menu behind it.
 *
 * It sits in the title bar rather than in Config because the whole reason vaults exist is
 * to keep things apart: personal notes from work notes, one client from another. A
 * separation you cannot see at a glance is one you will eventually write into the wrong
 * vault. So the active vault is always on screen, and switching is one click from there.
 *
 * Local vaults and remote Flashback Servers are listed together on purpose — from the
 * app's side they are the same thing, a place its data comes from. What differs is the
 * cost: switching to a remote just re-points the client and leaves the local API running
 * idle, while switching between two local vaults makes that API close one database and
 * open another.
 *
 * Built here rather than on a shared primitive because the app has no dropdown component
 * — every other selector is a native <select>, which cannot render this.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../translations';
import { listVaults, listRemotes, switchVault } from '../api/vaults.js';
import './VaultSwitcher.css';

export default function VaultSwitcher({ connection, onManageVaults }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const rootRef = useRef(null);

  const refresh = useCallback(async () => {
    const [v, r] = await Promise.all([listVaults(), listRemotes()]);
    setVaults(v.vaults ?? []);
    setRemotes(r ?? []);
  }, []);

  // Loaded on open rather than on mount — reading the registry on every launch would be
  // work nobody asked for. `connection` is in the deps for the case that actually bit:
  // the menu stays open across a switch (it lives in the title bar, outside the AppGate
  // that remounts), so without re-reading, every row keeps the `active` flag the server
  // sent BEFORE the switch and the menu goes on marking the vault you just left.
  useEffect(() => {
    if (!open) return;
    setError(null);
    refresh();
  }, [open, refresh, connection?.id, connection?.kind]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isRemote = connection?.kind === 'remote';
  // The product name lives in #app-title now, so the fallback here has to name a PLACE.
  // It is only reached in the browser-only dev fallback, where no vault id is known.
  const label = connection?.label ?? t('Local vault');

  async function handleSwitchVault(id) {
    if (busy) return;
    setBusy(id);
    setError(null);
    const result = await switchVault(id);
    setBusy(null);
    if (!result?.ok) {
      setError(result?.error ?? t('Could not switch vault.'));
      return;
    }
    // Closed by hand. The title bar sits OUTSIDE the AppGate that remounts on a
    // connection change, so this menu survives the switch and would otherwise hang open
    // over the vault it just opened.
    setOpen(false);
  }

  async function handleUseRemote(id) {
    if (busy) return;
    setBusy(id);
    setError(null);
    const result = await window.flashback?.useRemote?.(id);
    setBusy(null);
    if (!result?.ok) {
      setError(result?.error ?? t('Could not reach that server.'));
      return;
    }
    setOpen(false);
  }

  async function handleUseLocal() {
    if (busy) return;
    setBusy('local');
    await window.flashback?.useLocalVault?.();
    setBusy(null);
  }

  return (
    <div className="vault-switcher" ref={rootRef}>
      <button
        type="button"
        className="vault-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('Switch vault')}
        onClick={() => setOpen((o) => !o)}
      >
        {isRemote && <span className="vault-switcher__badge" aria-hidden="true" />}
        <span className="vault-switcher__name">{label}</span>
        <svg className="vault-switcher__chevron" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="vault-switcher__menu" role="menu">
          <div className="vault-switcher__section">{t('Vaults')}</div>

          {vaults.map((v) => (
            <button
              type="button"
              role="menuitem"
              key={v.id}
              className={`vault-switcher__item${v.active && !isRemote ? ' is-active' : ''}`}
              aria-current={v.active && !isRemote ? 'true' : undefined}
              disabled={!!busy || v.missing}
              onClick={() => (v.active && !isRemote ? handleUseLocal() : handleSwitchVault(v.id))}
            >
              {/* A dot, not a tick. A tick reads as "done"; the question this menu answers
                  is "which one am I in", which is a state, not a completed action. */}
              <span className={`vault-switcher__dot${v.active && !isRemote ? ' is-on' : ''}`}
                aria-hidden="true" />
              <span className="vault-switcher__label">{v.name}</span>
              {v.missing && <span className="vault-switcher__note">{t('folder missing')}</span>}
              {busy === v.id && <span className="vault-switcher__note">{t('switching…')}</span>}
            </button>
          ))}

          {remotes.length > 0 && (
            <>
              <div className="vault-switcher__section">{t('Remote servers')}</div>
              {remotes.map((r) => (
                <button
                  type="button"
                  role="menuitem"
                  key={r.id}
                  className={`vault-switcher__item${isRemote && connection?.id === r.id ? ' is-active' : ''}`}
                  aria-current={isRemote && connection?.id === r.id ? 'true' : undefined}
                  disabled={!!busy}
                  onClick={() => handleUseRemote(r.id)}
                >
                  <span className={`vault-switcher__dot${isRemote && connection?.id === r.id ? ' is-on' : ''}`}
                    aria-hidden="true" />
                  <span className="vault-switcher__label">{r.label}</span>
                  {busy === r.id && <span className="vault-switcher__note">{t('connecting…')}</span>}
                </button>
              ))}
            </>
          )}

          {error && <p className="vault-switcher__error" role="alert">{error}</p>}

          <div className="vault-switcher__divider" />
          <button
            type="button"
            role="menuitem"
            className="vault-switcher__item"
            onClick={() => { setOpen(false); onManageVaults?.(); }}
          >
            <span className="vault-switcher__dot" aria-hidden="true" />
            <span className="vault-switcher__label">{t('Manage vaults and remotes…')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
