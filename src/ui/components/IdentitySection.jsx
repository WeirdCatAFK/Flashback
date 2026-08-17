/**
 * IdentitySection — who this install stamps work as, rendered inside Config.
 *
 * The same idea as `git config user.name` / `user.email`: a name and an address you assert
 * about yourself. It goes into every new sidecar's `createdBy` and onto every Seal commit,
 * which until now were both stamped with the *vault name* — so renaming a vault changed the
 * apparent author of all future work, and two vaults belonging to one person looked like
 * two people.
 *
 * It is NOT a login. Nothing validates it and nothing gates on it; when remotes arrive they
 * authenticate with access tokens, and a server treats anything asserted here as a claim.
 * The section says so out loud, because a name-and-email form looks like a sign-up.
 *
 * Its own file rather than more of Config.jsx, which is already ~1,300 lines — the same
 * reason KeybindingsEditor and ThemeEditor are separate.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../translations';
import {
  getEffectiveIdentity, getStoredIdentity, setIdentity, setVaultIdentity,
} from '../api/identity.js';
import { identityError } from '../../shared/identity.js';
import './IdentitySection.css';

const EMPTY = { name: '', email: '' };

// The shared validator returns a code so the Electron main process can use it too; the
// sentences live here, where they can be translated.
function problemText(problem, t) {
  if (!problem) return null;
  switch (problem.code) {
    case 'required':       return problem.field === 'name' ? t('A name is required.') : t('An email is required.');
    case 'invalid-chars':  return t('Contains characters that cannot be used here.');
    case 'too-long':       return t('Too long (max 128 characters).');
    case 'not-an-address': return t('That does not look like an email address.');
    default:               return t('Something went wrong.');
  }
}

function sourceText(source, t) {
  switch (source) {
    case 'vault':  return t('from this vault’s override');
    case 'global': return t('from your identity');
    default:       return t('from your computer account — set a name and email to change it');
  }
}

export default function IdentitySection({ connection }) {
  const { t } = useT();

  const [effective, setEffective] = useState(null);
  const [global, setGlobal] = useState(EMPTY);
  const [override, setOverride] = useState(null);   // null = no override for this vault
  const [vaultId, setVaultId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    const [stored, live] = await Promise.all([
      getStoredIdentity(),
      getEffectiveIdentity().catch(() => null),
    ]);
    setGlobal(stored.user ?? EMPTY);
    setOverride(stored.override);
    setVaultId(stored.activeVaultId);
    setEffective(live);
  }, []);

  // Re-read on a vault switch: the override is per vault, so both the form and the
  // "stamping as" line describe a different thing after one.
  useEffect(() => { refresh(); }, [refresh, connection?.id]);

  const run = useCallback(async (key, fn, successMessage) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result?.ok === false) {
        setError(result.error ?? t('Something went wrong.'));
        return result;
      }
      setNotice(successMessage);
      await refresh();
      return result;
    } catch (e) {
      setError(e.message);
      return { ok: false };
    } finally {
      setBusy(null);
    }
  }, [refresh, t]);

  const globalProblem = problemText(identityError(global), t);
  const overrideProblem = override ? problemText(identityError(override), t) : null;

  const usesOverride = override !== null;

  function toggleOverride(on) {
    setError(null);
    setNotice(null);
    if (on) {
      // Seeded from the global identity so only the half that differs has to be typed —
      // usually the address.
      setOverride({ ...global });
      return;
    }
    // Turning it off is a real write, not just a UI state change: the stored override has
    // to go, or the next launch reads it back.
    setOverride(null);
    if (vaultId) run('clear-override', () => setVaultIdentity(vaultId, null), t('Override removed.'));
  }

  return (
    <section className="config-section">
      <h2 className="config-heading">{t('Identity')}</h2>
      <p className="config-hint">
        {t('The name and email stamped on documents you create and on every entry in the vault history. This is an authoring label, not an account')}
      </p>

      {effective && (
        <p className="identity-current">
          {t('Stamping new work as')}{' '}
          <code>{effective.author}</code>{' '}
          <span className="identity-current__source">{sourceText(effective.source, t)}</span>
        </p>
      )}

      {error && <p className="identity-msg identity-msg--error" role="alert">{error}</p>}
      {notice && <p className="identity-msg identity-msg--ok">{notice}</p>}

      <table className="config-table">
        <tbody>
          <tr>
            <td><label htmlFor="identity-name">{t('Name')}</label></td>
            <td>
              <input id="identity-name" value={global.name} autoComplete="off"
                placeholder={effective?.source === 'default' ? effective.name : undefined}
                onChange={(e) => setGlobal((g) => ({ ...g, name: e.target.value }))} />
            </td>
          </tr>
          <tr>
            <td><label htmlFor="identity-email">{t('Email')}</label></td>
            <td>
              <input id="identity-email" type="email" value={global.email} autoComplete="off"
                placeholder={effective?.source === 'default' ? effective.email : undefined}
                onChange={(e) => setGlobal((g) => ({ ...g, email: e.target.value }))} />
            </td>
          </tr>
        </tbody>
      </table>

      {globalProblem && <p className="identity-msg identity-msg--error">{globalProblem}</p>}

      <div className="identity-actions">
        <button type="button" className="identity-btn identity-btn--primary"
          disabled={!!busy || !!globalProblem}
          onClick={() => run('save', () => setIdentity(global), t('Identity saved.'))}>
          {busy === 'save' ? t('Saving…') : t('Save identity')}
        </button>
      </div>

      <label className="config-checkbox identity-toggle">
        <input type="checkbox" checked={usesOverride} disabled={!vaultId || !!busy}
          onChange={(e) => toggleOverride(e.target.checked)} />
        {t('Use a different identity in this vault')}
      </label>
      <p className="config-hint identity-toggle__hint">
        {t('Keeps a separate name and email for this vault only — a work address on a work vault, say. It is stored on this computer and does not travel with the vault folder.')}
      </p>

      {usesOverride && (
        <>
          <table className="config-table">
            <tbody>
              <tr>
                <td><label htmlFor="identity-vault-name">{t('Name')}</label></td>
                <td>
                  <input id="identity-vault-name" value={override.name} autoComplete="off"
                    onChange={(e) => setOverride((o) => ({ ...o, name: e.target.value }))} />
                </td>
              </tr>
              <tr>
                <td><label htmlFor="identity-vault-email">{t('Email')}</label></td>
                <td>
                  <input id="identity-vault-email" type="email" value={override.email} autoComplete="off"
                    onChange={(e) => setOverride((o) => ({ ...o, email: e.target.value }))} />
                </td>
              </tr>
            </tbody>
          </table>

          {overrideProblem && <p className="identity-msg identity-msg--error">{overrideProblem}</p>}

          <div className="identity-actions">
            <button type="button" className="identity-btn identity-btn--primary"
              disabled={!!busy || !!overrideProblem}
              onClick={() => run('save-override', () => setVaultIdentity(vaultId, override),
                t('Vault identity saved.'))}>
              {busy === 'save-override' ? t('Saving…') : t('Save for this vault')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
