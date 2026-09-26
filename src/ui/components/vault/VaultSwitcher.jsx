/**
 * VaultSwitcher — the vault name in the title bar and the menu behind it. The
 * active vault stays on screen because a separation you cannot see at a glance
 * is one you will eventually write into the wrong vault. Local vaults and
 * remote servers are listed together: to the app they are the same thing, a
 * place its data comes from.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Popover from '../base/Popover';
import { useT } from '../../translations/index';
import { listVaults, listRemotes, switchVault, connectRemote, connectLocal } from '../../api/vaults.js';
import './VaultSwitcher.css';

function MenuItem({ active, disabled, onClick, label, note }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`popover__item vault-switcher__item${active ? ' is-active' : ''}`}
      aria-current={active ? 'true' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`vault-switcher__dot${active ? ' is-on' : ''}`} aria-hidden="true" />
      <span className="vault-switcher__label">{label}</span>
      {note && <span className="vault-switcher__note">{note}</span>}
    </button>
  );
}

export default function VaultSwitcher({ connection, onManageVaults }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const triggerRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  const refresh = useCallback(async () => {
    const [v, r] = await Promise.all([listVaults(), listRemotes()]);
    setVaults(v.vaults ?? []);
    setRemotes(r ?? []);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    refresh();
  }, [open, refresh, connection?.id, connection?.kind]);

  const isRemote = connection?.kind === 'remote';
  const label = connection?.label ?? t('Local vault');

  const attempt = async (id, action, failure) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    const result = await action();
    setBusy(null);
    if (!result?.ok) { setError(result?.error ?? failure); return; }
    close();
  };

  return (
    <div className="vault-switcher">
      <button
        ref={triggerRef}
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
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <Popover anchorRef={triggerRef} open={open} onClose={close} className="vault-switcher__menu" ariaLabel={t('Switch vault')}>
        <div className="popover__heading">{t('Vaults')}</div>
        {vaults.map((v) => (
          <MenuItem
            key={v.id}
            active={v.active && !isRemote}
            disabled={!!busy || v.missing}
            onClick={() => (v.active ? attempt('local', connectLocal, t('Could not switch vault.')) : attempt(v.id, () => switchVault(v.id), t('Could not switch vault.')))}
            label={v.name}
            note={v.missing ? t('folder missing') : busy === v.id ? t('switching…') : null}
          />
        ))}

        {remotes.length > 0 && (
          <>
            <div className="popover__heading">{t('Remote servers')}</div>
            {remotes.map((r) => (
              <MenuItem
                key={r.id}
                active={isRemote && connection?.id === r.id}
                disabled={!!busy}
                onClick={() => attempt(r.id, () => connectRemote(r.id), t('Could not reach that server.'))}
                label={r.label}
                note={busy === r.id ? t('connecting…') : null}
              />
            ))}
          </>
        )}

        {error && <p className="vault-switcher__error" role="alert">{error}</p>}

        <div className="popover__sep" />
        <MenuItem onClick={() => { close(); onManageVaults?.(); }} label={t('Manage vaults and remotes…')} />
      </Popover>
    </div>
  );
}
