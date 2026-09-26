/**
 * IdentitySection — who this install stamps work as, the You section of Config.
 *
 * The same idea as `git config user.name` / `user.email`: a name and an address you assert
 * about yourself. It goes into every new sidecar's `createdBy` and onto every Seal commit,
 * which were once both stamped with the *vault name*, so renaming a vault changed the
 * apparent author of all future work, and two vaults belonging to one person looked like
 * two people.
 *
 * It is NOT a login. Nothing validates it and nothing gates on it; a server authenticates
 * with access tokens and treats anything asserted here as a claim. The section says so out
 * loud, because a name-and-email form looks like a sign-up. State is in useIdentity.js.
 */

import Toggle from '../../components/base/Toggle';
import { identityError } from '../../../shared/identity.js';
import { useT } from '../../translations/index';
import ConfigRow from './ConfigRow';
import { useSearching } from './rowsContext.js';

/** The shared validator returns a code so Electron main can use it too; the sentences live here, where they are translated. */
function problemText(problem, t) {
  if (!problem) return null;
  switch (problem.code) {
    case 'required': return problem.field === 'name' ? t('A name is required.') : t('An email is required.');
    case 'invalid-chars': return t('Contains characters that cannot be used here.');
    case 'too-long': return t('Too long (max 128 characters).');
    case 'not-an-address': return t('That does not look like an email address.');
    default: return t('Something went wrong.');
  }
}

function sourceText(source, t) {
  switch (source) {
    case 'vault': return t('from this vault’s override');
    case 'global': return t('from your identity');
    default: return t('from your computer account; set a name and email to change it');
  }
}

export default function IdentitySection({ identity: id }) {
  const { t } = useT();
  const searching = useSearching();
  const globalProblem = problemText(identityError(id.global), t);
  const overrideProblem = id.override ? problemText(identityError(id.override), t) : null;
  const fallback = id.effective?.source === 'default' ? id.effective : null;

  return (
    <>
      {!searching && (
        <>
          <p className="cf-lede">
            {t('The name and email stamped on documents you create and on every entry in the Seal history. It isn’t a login: nothing checks it, and a server trusts only your token.')}
          </p>
          {id.effective && (
            <p className="cf-stamp">
              {t('Stamping new work as')} <code>{id.effective.author}</code> <span>{sourceText(id.effective.source, t)}</span>
            </p>
          )}
        </>
      )}

      <ConfigRow id="name" htmlFor="cf-name">
        <input id="cf-name" className="field field--sm cf-in" value={id.global.name} autoComplete="off"
          placeholder={fallback?.name} onChange={(e) => id.setGlobalField('name', e.target.value)} />
      </ConfigRow>
      <ConfigRow id="email" htmlFor="cf-email">
        <input id="cf-email" className="field field--sm cf-in" type="email" value={id.global.email} autoComplete="off"
          placeholder={fallback?.email} onChange={(e) => id.setGlobalField('email', e.target.value)} />
      </ConfigRow>
      {!searching && (
        <div className="cf-actions">
          <button type="button" className="btn btn--quiet-accent btn--sm" disabled={!!id.busy || !!globalProblem} onClick={id.saveGlobal}>
            {id.busy === 'save' ? t('Saving…') : t('Save identity')}
          </button>
          {globalProblem && <span className="cf-error">{globalProblem}</span>}
          {!globalProblem && id.notice && id.busy === null && <span className="cf-ok" role="status">{id.notice}</span>}
        </div>
      )}

      <ConfigRow id="override">
        <Toggle checked={id.override !== null} disabled={!id.vaultId || !!id.busy} onChange={id.toggleOverride}
          ariaLabel={t('A different identity in this vault')} />
      </ConfigRow>

      {id.override && !searching && (
        <div className="cf-sub">
          <div className="cf-row">
            <div className="cf-label"><label className="cf-label__name" htmlFor="cf-vault-name">{t('Name here')}</label></div>
            <div className="cf-control">
              <input id="cf-vault-name" className="field field--sm cf-in" value={id.override.name} autoComplete="off"
                placeholder={id.global.name} onChange={(e) => id.setOverrideField('name', e.target.value)} />
            </div>
          </div>
          <div className="cf-row">
            <div className="cf-label"><label className="cf-label__name" htmlFor="cf-vault-email">{t('Email here')}</label></div>
            <div className="cf-control">
              <input id="cf-vault-email" className="field field--sm cf-in" type="email" value={id.override.email} autoComplete="off"
                placeholder={id.global.email} onChange={(e) => id.setOverrideField('email', e.target.value)} />
            </div>
          </div>
          <div className="cf-actions">
            <button type="button" className="btn btn--quiet-accent btn--sm" disabled={!!id.busy || !!overrideProblem} onClick={id.saveOverride}>
              {id.busy === 'save-override' ? t('Saving…') : t('Save for this vault')}
            </button>
            {overrideProblem && <span className="cf-error">{overrideProblem}</span>}
          </div>
        </div>
      )}

      {id.error && <p className="cf-error" role="alert">{id.error}</p>}
    </>
  );
}
