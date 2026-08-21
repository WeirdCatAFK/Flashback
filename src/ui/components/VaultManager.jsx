/**
 * VaultManager — creating, adopting, renaming and connecting to vaults.
 *
 * This used to be a section inside Config, which was the wrong home for it: Config is a
 * vault's own settings, and everything here is ABOUT vaults rather than in one. Switching
 * away from a vault is not something that happens inside it. So it is an overlay that
 * covers the app entirely — the vault you were in goes dark behind it, which is the whole
 * point of the presentation.
 *
 * Two panes, after the shape Obsidian settled on:
 *   left  — every place this app can open: local vaults, then remote servers. Clicking one
 *           opens it. The active one is marked.
 *   right — what this app IS (name and version, the only screen that shows it besides
 *           Config → About), then the three things you can do that aren't "open one of
 *           these": create, adopt from disk, connect to a remote.
 *
 * Per-row actions (rename, remove) reveal on hover and on focus-within rather than hiding
 * behind a ⋮ menu — the app has no popover-menu primitive, and a second nested menu inside
 * a dialog is a focus-trap problem nobody needs. focus-within is what keeps them reachable
 * from the keyboard.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../translations';
import Modal from './shared/Modal.jsx';
import { useConfirm } from './shared/ConfirmDialog.jsx';
import {
  listVaults, createVault, renameVault, removeVault, switchVault, openVaultFromDisk,
  listRemotes, addRemote, removeRemote, testRemote,
} from '../api/vaults.js';
import { vaultNameError } from '../../shared/vaultName.js';
// The real app mark, the same file electron-builder ships as the installer/window icon.
// Imported rather than referenced by path so Vite fingerprints it and it resolves under
// file:// in a packaged build, where an absolute /assets URL would not.
import logoUrl from '../assets/flashback.png';
import './VaultManager.css';

// The shared validator returns a code so the Electron main process can use it too; the
// sentences live here, where they can be translated.
function nameErrorText(code, t) {
  switch (code) {
    case 'required':      return t('Required.');
    case 'invalid-chars': return t('Contains invalid characters.');
    case 'too-long':      return t('Too long (max 64 characters).');
    case 'trailing-dot':  return t('Cannot end with a dot or a space.');
    case 'reserved':      return t('That name is reserved.');
    default:              return null;
  }
}

/** One row in the left rail. Shared by vaults and remotes so both read the same. */
function Row({ active, disabled, primaryLabel, name, tags, detail, onOpen, children }) {
  return (
    <li className={`vm-row${active ? ' is-active' : ''}`}>
      <button
        type="button"
        className="vm-row__open"
        aria-current={active ? 'true' : undefined}
        disabled={disabled}
        title={primaryLabel}
        onClick={onOpen}
      >
        <span className="vm-row__name">
          {/* Same marker as the title-bar quick switch: a dot means "this is the one you
              are in". The row itself stays quiet — an accent-tinted row with a bar down
              its side shouted the state and still read as a selection rather than a
              location. */}
          <span className={`vm-dot${active ? ' is-on' : ''}`} aria-hidden="true" />
          <span className="vm-row__title">{name}</span>
          {tags}
        </span>
        <span className="vm-row__detail" title={detail}>{detail}</span>
      </button>
      {children && <div className="vm-row__actions">{children}</div>}
    </li>
  );
}

export default function VaultManager({ connection, onClose }) {
  const { t } = useT();
  const confirm = useConfirm();

  const [vaults, setVaults] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [newVaultName, setNewVaultName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const [remoteForm, setRemoteForm] = useState({ label: '', url: '', token: '' });
  const [showRemoteForm, setShowRemoteForm] = useState(false);

  const refresh = useCallback(async () => {
    const [v, r] = await Promise.all([listVaults(), listRemotes()]);
    setVaults(v.vaults ?? []);
    setRemotes(r ?? []);
  }, []);

  useEffect(() => { refresh(); }, [refresh, connection?.id]);

  useEffect(() => {
    window.flashback?.getAppVersion?.().then(setVersion).catch(() => {});
  }, []);

  const run = useCallback(async (key, fn, successMessage = null) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result && result.ok === false) {
        if (!result.canceled) setError(result.error ?? t('Something went wrong.'));
        return result;
      }
      if (result?.warning) setNotice(result.warning);
      else if (successMessage) setNotice(successMessage);
      await refresh();
      return result;
    } catch (e) {
      setError(e.message);
      return { ok: false, error: e.message };
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const newNameProblem = newVaultName ? nameErrorText(vaultNameError(newVaultName), t) : null;
  const onRemote = connection?.kind === 'remote';

  async function handleCreate() {
    if (newNameProblem || !newVaultName.trim()) return;
    const result = await run('create', () => createVault(newVaultName), t('Vault created.'));
    if (result?.ok) {
      setNewVaultName('');
      setShowCreate(false);
    }
  }

  async function handleRename(id) {
    const problem = nameErrorText(vaultNameError(renameValue), t);
    if (problem) { setError(problem); return; }
    const result = await run(`rename-${id}`, () => renameVault(id, renameValue), t('Vault renamed.'));
    if (result?.ok) setRenamingId(null);
  }

  async function handleRemove(vault) {
    const ok = await confirm({
      title: t('Remove this vault from the list?'),
      message: t('Nothing on disk is deleted. The folder stays where it is and can be opened again later.'),
      confirmLabel: t('Remove from list'),
      tone: 'danger',
    });
    if (!ok) return;
    await run(`remove-${vault.id}`, () => removeVault(vault.id), t('Vault removed from the list.'));
  }

  async function handleAddRemote() {
    const result = await run('add-remote', () => addRemote(remoteForm), t('Remote added.'));
    if (result?.ok) {
      setRemoteForm({ label: '', url: '', token: '' });
      setShowRemoteForm(false);
    }
  }

  async function handleTestRemote(id) {
    const result = await run(`test-${id}`, () => testRemote(id));
    if (result?.ok) {
      const v = result.identity;
      setNotice(t('Connected — vault "{name}", Flashback {version}.')
        .replace('{name}', v?.vaultName ?? '?')
        .replace('{version}', v?.appVersion ?? '?'));
    }
  }

  // Opening anything closes the manager on success. A vault switch remounts the app under
  // the overlay anyway, so leaving it up would hide the vault it just opened.
  async function handleOpenVault(v) {
    // Already the vault the local API has open: re-point rather than switch. On a remote
    // that is the way home and involves no database work — see the note in VaultSwitcher.
    if (v.active) {
      if (onRemote) await window.flashback?.useLocalVault?.();
      onClose();
      return;
    }
    const result = await run(`switch-${v.id}`, () => switchVault(v.id));
    if (result?.ok !== false) onClose();
  }

  async function handleUseRemote(r) {
    const result = await run(`use-${r.id}`, () => window.flashback?.useRemote?.(r.id));
    if (result?.ok !== false) onClose();
  }

  return (
    <Modal ariaLabel={t('Vaults and remotes')} onClose={onClose} size="xl" className="vault-manager-modal">
      <div className="vault-manager">
        <aside className="vault-manager__rail" aria-label={t('Vaults and remotes')}>
          <p className="vm-section">{t('Vaults')}</p>
          <ul className="vm-list">
            {vaults.map((v) => (
              renamingId === v.id ? (
                <li key={v.id} className="vm-row vm-row--editing">
                  <input
                    aria-label={t('New vault name')}
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(v.id);
                      // Stops Modal's global Escape handler from closing the whole dialog
                      // when the user only meant to abandon the rename.
                      if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null); }
                    }}
                  />
                  <div className="vm-row__actions is-open">
                    <button type="button" className="vm-mini" onClick={() => handleRename(v.id)}
                      disabled={busy === `rename-${v.id}`}>
                      {busy === `rename-${v.id}` ? t('Renaming…') : t('Save')}
                    </button>
                    <button type="button" className="vm-mini" onClick={() => setRenamingId(null)}>
                      {t('Cancel')}
                    </button>
                  </div>
                </li>
              ) : (
                <Row
                  key={v.id}
                  active={v.active && !onRemote}
                  disabled={!!busy || v.missing}
                  primaryLabel={v.active && !onRemote ? t('Back to this vault') : t('Open this vault')}
                  name={v.name}
                  detail={v.path}
                  onOpen={() => handleOpenVault(v)}
                  tags={
                    <>
                      {busy === `switch-${v.id}` && <span className="vm-tag">{t('opening…')}</span>}
                      {v.missing && <span className="vm-tag vm-tag--warn">{t('folder missing')}</span>}
                    </>
                  }
                >
                  <button type="button" className="vm-mini" disabled={!!busy}
                    onClick={() => { setRenamingId(v.id); setRenameValue(v.name); setError(null); }}>
                    {t('Rename')}
                  </button>
                  <button type="button" className="vm-mini" disabled={!!busy || (v.active && !onRemote)}
                    onClick={() => handleRemove(v)}>
                    {t('Remove')}
                  </button>
                </Row>
              )
            ))}
          </ul>

          <p className="vm-section">{t('Remote servers')}</p>
          {remotes.length === 0 ? (
            <p className="vm-empty">{t('No remote servers connected.')}</p>
          ) : (
            <ul className="vm-list">
              {remotes.map((r) => (
                <Row
                  key={r.id}
                  active={onRemote && connection?.id === r.id}
                  disabled={!!busy}
                  primaryLabel={t('Connect to this server')}
                  name={r.label}
                  detail={r.url}
                  onOpen={() => handleUseRemote(r)}
                  tags={
                    <>
                      {busy === `use-${r.id}` && <span className="vm-tag">{t('connecting…')}</span>}
                      {!r.hasToken && <span className="vm-tag vm-tag--warn">{t('no access token')}</span>}
                    </>
                  }
                >
                  <button type="button" className="vm-mini" disabled={!!busy}
                    onClick={() => handleTestRemote(r.id)}>
                    {busy === `test-${r.id}` ? t('Testing…') : t('Test')}
                  </button>
                  <button type="button" className="vm-mini" disabled={!!busy}
                    onClick={() => run(`remove-remote-${r.id}`, () => removeRemote(r.id), t('Remote removed.'))}>
                    {t('Remove')}
                  </button>
                </Row>
              ))}
            </ul>
          )}
        </aside>

        <div className="vault-manager__main">
          <button type="button" className="vm-close" onClick={onClose} aria-label={t('Close')}>×</button>

          {/* A horizontal lockup rather than a centred stack. The stack was ~120px tall,
              and that is height the panel cannot spare once the remote form is open — the
              dialog has to grow to fit its tallest state without ever scrolling. */}
          <div className="vm-brand">
            <img className="vm-brand__mark" src={logoUrl} alt="" width="52" height="52" />
            <div className="vm-brand__text">
              <p className="vm-brand__name">Flashback</p>
              {version && (
                <p className="vm-brand__version">
                  {t('Version {version}').replace('{version}', version)}
                </p>
              )}
            </div>
          </div>

          <p className="vm-explainer">
            {t('A vault is a self-contained set of documents, cards and review history. Keeping separate vaults is how you keep unrelated work apart')}
          </p>

          {error && <p className="vm-msg vm-msg--error" role="alert">{error}</p>}
          {notice && <p className="vm-msg vm-msg--ok">{notice}</p>}

          <div className="vm-actions">
            <div className="vm-action">
              <div className="vm-action__text">
                <p className="vm-action__title">{t('Create new vault')}</p>
                <p className="vm-action__desc">{t('Start an empty vault in its own folder on this computer.')}</p>
              </div>
              <button type="button" className="vm-btn vm-btn--primary" disabled={!!busy}
                onClick={() => { setShowCreate((s) => !s); setShowRemoteForm(false); }}>
                {t('Create')}
              </button>
            </div>

            {showCreate && (
              <div className="vm-form">
                <input
                  aria-label={t('New vault name')}
                  placeholder={t('New vault name')}
                  autoFocus
                  value={newVaultName}
                  onChange={(e) => setNewVaultName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                />
                <button type="button" className="vm-btn vm-btn--primary" onClick={handleCreate}
                  disabled={!!busy || !newVaultName.trim() || !!newNameProblem}>
                  {busy === 'create' ? t('Creating…') : t('Create vault')}
                </button>
                {newNameProblem && <p className="vm-msg vm-msg--error">{newNameProblem}</p>}
              </div>
            )}

            <div className="vm-action">
              <div className="vm-action__text">
                <p className="vm-action__title">{t('Open folder as vault')}</p>
                <p className="vm-action__desc">{t('Choose a vault folder already on this computer.')}</p>
              </div>
              <button type="button" className="vm-btn" disabled={!!busy}
                onClick={() => run('adopt', openVaultFromDisk, t('Vault added.'))}>
                {busy === 'adopt' ? t('Opening…') : t('Open')}
              </button>
            </div>

            <div className="vm-action">
              <div className="vm-action__text">
                <p className="vm-action__title">{t('Connect to a remote')}</p>
                <p className="vm-action__desc">{t('A remote is a Flashback Server holding a vault somewhere else.')}</p>
              </div>
              <button type="button" className="vm-btn" disabled={!!busy}
                onClick={() => { setShowRemoteForm((s) => !s); setShowCreate(false); }}>
                {t('Connect')}
              </button>
            </div>

            {/* Name and address share a row: three stacked fields plus the hint and the
                buttons was the single tallest thing this panel can contain, and it was
                what pushed the dialog into scrolling. */}
            {showRemoteForm && (
              <div className="vm-form vm-form--fields">
                <div className="vm-form__pair">
                  <label>
                    {t('Name')}
                    <input value={remoteForm.label}
                      onChange={(e) => setRemoteForm((f) => ({ ...f, label: e.target.value }))} />
                  </label>
                  <label>
                    {t('Server address')}
                    <input placeholder="https://flashback.example.com" value={remoteForm.url}
                      onChange={(e) => setRemoteForm((f) => ({ ...f, url: e.target.value }))} />
                  </label>
                </div>
                <label>
                  {t('Access token')}
                  <input type="password" autoComplete="off" value={remoteForm.token}
                    onChange={(e) => setRemoteForm((f) => ({ ...f, token: e.target.value }))} />
                </label>
                <div className="vm-form__buttons">
                  <p className="vm-hint">
                    {t('The token is stored with your operating system’s secure credential store, never in a plain file.')}
                    {' '}
                    {/* Two entries on one address are a normal thing to want — a second
                        account on the same server — and the name is what tells them apart.
                        Said here because the alternative is discovering it by watching the
                        first one disappear. */}
                    {t('Give the same server a different name to connect as a second account.')}
                  </p>
                  <button type="button" className="vm-btn vm-btn--primary" onClick={handleAddRemote}
                    disabled={!!busy || !remoteForm.url.trim()}>
                    {busy === 'add-remote' ? t('Adding…') : t('Add remote')}
                  </button>
                  <button type="button" className="vm-btn" onClick={() => setShowRemoteForm(false)}>
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
