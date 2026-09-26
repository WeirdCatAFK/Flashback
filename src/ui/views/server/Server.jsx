/**
 * Server Management — the tab a remote Flashback Server gets, set as a report page like
 * Metadata and Seal: the facts about the server, who you are there, and for an admin the
 * people and their tokens.
 *
 * One sentence leads: who you're signed in as, your role, and for an admin how many seats
 * are in use; a release waiting on the server is one accented line under it, since upgrading
 * a server isn't a click. Your role is a ladder (the steps you hold filled, yours marked),
 * with "What each role can do" opening all four.
 *
 * People are quiet rows, like tags in Metadata; Progress, Logs (the Author only), New
 * token, Revoke and Deactivate appear on hover, and every confirmation happens inside the row. A deactivated person can
 * be reactivated while a seat is free. Adding someone is an inline row that hands you their
 * first token at once. A token is shown once, in a panel that stays until it is dismissed
 * (the store keeps only a hash, so the panel is the only copy there will ever be). Readers
 * don't see People at all: there is nothing in it they can act on.
 *
 * Which rows offer which actions mirrors the API's rules (routes/accounts.js): an admin
 * manages Readers only, the Author everyone but themselves, and nobody their own row.
 */

import { useState, useEffect } from 'react';
import { getVaultIdentity } from '../../api/vaults';
import { createAccount, updateAccount, issueToken, revokeToken, rotatePureToken } from '../../api/accounts';
import { roleLabels, roleBlurbs, signedInAs, nowRole, addedAs, fmtDate, grantable, grantableRoles } from './roles.js';
import useAccounts from './useAccounts';
import './Server.css';
import { LoadingState } from '../../components/base/StateView';
import { useSession } from '../../sessionContext.js';
import { ROLES, ROLE_ORDER } from '../../../shared/roles.js';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';

/** Enter commits and Escape backs out, for the inline add row. */
const formKeys = (onSubmit, onCancel) => (e) => {
  if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
};

/**
 * A token, shown once. Deliberately obtrusive rather than a toast that can be missed, and it
 * says plainly that closing it loses the token.
 */
function TokenReveal({ title, token, onDismiss }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="sv-token" role="alert">
      <p><b>{title}</b> {t('Copy it now: it’s shown this once, and closing this panel loses it.')}</p>
      <code className="sv-token__value">{token}</code>
      <div className="sv-token__acts">
        <button type="button" className="btn btn--quiet-accent btn--sm"
          onClick={async () => { try { await navigator.clipboard.writeText(token); setCopied(true); } catch {} }}>
          {copied ? t('Copied') : t('Copy')}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDismiss}>{t('Done')}</button>
      </div>
    </div>
  );
}

/** Your place on the ladder, lowest to highest: the steps you hold are filled, yours is marked. */
function RoleLadder({ role }) {
  const { t } = useT();
  const labels = roleLabels(t);
  const blurbs = roleBlurbs(t);
  const mine = ROLE_ORDER.indexOf(role);
  return (
    <>
      <div className="sv-ladder" role="img" aria-label={t('Roles, lowest to highest; yours is {role}.', { role: labels[role] })}>
        {ROLE_ORDER.map((r, i) => (
          <span key={r} className={`sv-step${i <= mine ? ' is-held' : ''}${i === mine ? ' is-mine' : ''}`}>
            <i /><span>{labels[r]}</span>
          </span>
        ))}
      </div>
      <p className="sv-blurb">
        {blurbs[role]}
        {role !== ROLES.AUTHOR && ` ${t('Each role can do everything the ones before it can.')}`}
      </p>
      <details className="sv-roles">
        <summary>{t('What each role can do')}</summary>
        <dl>
          {ROLE_ORDER.map((r) => (<div key={r}><dt>{labels[r]}</dt><dd>{blurbs[r]}</dd></div>))}
        </dl>
      </details>
    </>
  );
}

function YouHere({ info, connection }) {
  const { t } = useT();
  const { account, role, error } = useSession();
  return (
    <section className="sv-sec">
      <h2 className="sv-h">{t('You here')}</h2>
      <dl className="sv-facts">
        <dt>{t('Vault')}</dt><dd>{info?.vaultName ?? '—'}</dd>
        <dt>{t('Address')}</dt><dd className="sv-mono">{connection?.url ?? '—'}</dd>
        <dt>{t('You are')}</dt>
        <dd>{account ? <>{account.name} <span className="sv-mono sv-dim">{account.email}</span></> : t('Unknown')}</dd>
        <dt>{t('Version')}</dt>
        <dd className="sv-mono sv-dim">
          {info?.appVersion ?? '—'}
          {info && ` · ${t('schema')} ${info.schemaVersion} · ${t('files')} ${info.canonicalVersion}`}
        </dd>
        <dt>{t('Your role')}</dt>
        <dd>{role ? <RoleLadder role={role} /> : <span className="sv-dim">{error || t('Unknown')}</span>}</dd>
      </dl>
    </section>
  );
}

/** A confirmation that takes the row's place, in the app's own words. */
function RowConfirm({ title, detail, goLabel, onKeep, onGo }) {
  const { t } = useT();
  return (
    <div className="sv-row is-confirming" role="group" aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onKeep(); } }}>
      <div className="sv-text">
        <span className="sv-name">{title}</span>
        <span className="sv-desc">{detail}</span>
      </div>
      <span className="sv-acts is-on">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onKeep} autoFocus>{t('Cancel')}</button>
        <button type="button" className="btn btn--danger-quiet btn--sm" onClick={onGo}>{goLabel}</button>
      </span>
    </div>
  );
}

function AddRow({ role, busy, onAdd, onCancel }) {
  const { t } = useT();
  const labels = roleLabels(t);
  const blurbs = roleBlurbs(t);
  const [form, setForm] = useState({ name: '', email: '', role: ROLES.READER });
  const submit = () => { if (form.name.trim() && !busy) onAdd({ ...form, name: form.name.trim(), email: form.email.trim() }); };
  const keys = formKeys(submit, onCancel);
  return (
    <div className="sv-row is-editing sv-add">
      <div className="sv-add__fields">
        <input className="field field--sm" placeholder={t('Name')} aria-label={t('Name')} value={form.name} autoFocus autoComplete="off"
          onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={keys} />
        <input className="field field--sm" type="email" placeholder={t('Email')} aria-label={t('Email')} value={form.email} autoComplete="off"
          onChange={(e) => setForm({ ...form, email: e.target.value })} onKeyDown={keys} />
        <select className="field field--sm" aria-label={t('Role')} value={form.role} onKeyDown={keys}
          onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {grantableRoles(role).map((r) => <option key={r} value={r}>{labels[r]}</option>)}
        </select>
      </div>
      <p className="sv-add__hint">{blurbs[form.role]}</p>
      <span className="sv-acts is-on">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="btn btn--quiet-accent btn--sm" onClick={submit} disabled={!form.name.trim() || busy}>
          {t('Add and make a token')}
        </button>
      </span>
    </div>
  );
}

function PersonRow({ account, you, role, full, busy, onRole, onProgress, onLogs, onToken, onConfirm, onReactivate }) {
  const { t, tp, locale, formatNumber } = useT();
  const labels = roleLabels(t);
  const isYou = account.id === you?.id;
  const manage = !isYou && grantable(role, account.role);
  const live = (account.tokens ?? []).filter((tk) => tk.active).length;

  const acts = account.active ? (
    <>
      <button type="button" className="link-action" disabled={busy} onClick={onProgress}>{t('Progress')}</button>
      {onLogs && <button type="button" className="link-action" disabled={busy} onClick={onLogs}>{t('Logs')}</button>}
      {manage && <button type="button" className="link-action" disabled={busy} onClick={onToken}>{t('New token')}</button>}
      {manage && live > 0 && (
        <button type="button" className="link-action link-action--danger" disabled={busy} onClick={() => onConfirm('revoke')}>{t('Revoke')}</button>
      )}
      {manage && (
        <button type="button" className="link-action link-action--danger" disabled={busy} onClick={() => onConfirm('deactivate')}>{t('Deactivate')}</button>
      )}
    </>
  ) : (onLogs || manage) && (
    <>
      {onLogs && <button type="button" className="link-action" disabled={busy} onClick={onLogs}>{t('Logs')}</button>}
      {manage && (
        <button type="button" className="link-action" disabled={busy || full} onClick={onReactivate}
          title={full ? t('No free seat: deactivate someone first.') : undefined}>
          {t('Reactivate')}
        </button>
      )}
    </>
  );

  return (
    <div className={`sv-row${account.active ? '' : ' is-off'}`} role="listitem" tabIndex={0}>
      <div className="sv-text">
        <span className="sv-name">
          {account.name}
          {isYou && <span className="sv-mark">{t('you')}</span>}
          {!account.active && <span className="sv-mark">{t('deactivated')}</span>}
        </span>
        <span className="sv-desc sv-mono">{account.email}</span>
      </div>
      <span className="sv-cell">
        {manage && account.active && grantableRoles(role).length > 1 ? (
          <select className="field field--sm sv-select" value={account.role} disabled={busy}
            aria-label={t('Role for {name}', { name: account.name })}
            onChange={(e) => onRole(e.target.value)}>
            {grantableRoles(role).map((r) => <option key={r} value={r}>{labels[r]}</option>)}
          </select>
        ) : (
          <span className={`sv-role${account.role === ROLES.AUTHOR ? ' is-author' : ''}`}>{labels[account.role]}</span>
        )}
      </span>
      <span className="sv-cell sv-facet sv-mono sv-dim" title={t('Active tokens')}>
        {tp('{n} token', '{n} tokens', live, { n: formatNumber(live) })}
      </span>
      <span className="sv-cell sv-facet sv-date sv-mono sv-dim">
        {t('added {date}', { date: fmtDate(account.createdAt, locale) })}
      </span>
      {acts && <span className="sv-acts">{acts}</span>}
    </div>
  );
}

function People({ people, onViewProgress, onViewLogs }) {
  const { t, tp, formatNumber } = useT();
  const { can, role } = useSession();
  const { accounts, you, limit, loading, error, busy, run, activeCount, full } = people;
  const [reveal, setReveal] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState(null);

  if (loading) return <LoadingState message={t('Loading accounts…')} />;

  const act = async (key, fn, message) => {
    setNotice(null);
    const done = await run(key, async () => { await fn(); return true; });
    if (done && message) setNotice(message);
  };

  const add = async (form) => {
    setNotice(null);
    const made = await run('create', async () => {
      const created = await createAccount(form);
      const issued = await issueToken(created.id, 'Issued from the app');
      return { created, issued };
    });
    if (!made) return;
    setAdding(false);
    setReveal({ title: addedAs(t, made.created.role, made.created.name), token: made.issued.token });
  };

  const confirmRow = (a) => {
    const kind = confirming.kind;
    const go = async () => {
      setConfirming(null);
      if (kind === 'deactivate') {
        await act(`off-${a.id}`, () => updateAccount(a.id, { active: false }),
          t('{name} is deactivated. Their progress is kept.', { name: a.name }));
      } else {
        const live = (a.tokens ?? []).filter((tk) => tk.active);
        await act(`revoke-${a.id}`, async () => { for (const tk of live) await revokeToken(tk.id); },
          t('{name}’s tokens are revoked.', { name: a.name }));
      }
    };
    return kind === 'deactivate' ? (
      <RowConfirm key={a.id} title={t('Deactivate {name}?', { name: a.name })}
        detail={t('Every token they hold stops working immediately. Their study progress is kept, so reactivating resumes rather than restarts.')}
        goLabel={t('Deactivate')} onKeep={() => setConfirming(null)} onGo={go} />
    ) : (
      <RowConfirm key={a.id} title={t('Revoke {name}’s tokens?', { name: a.name })}
        detail={t('They lose access immediately and will need a new token to return.')}
        goLabel={t('Revoke')} onKeep={() => setConfirming(null)} onGo={go} />
    );
  };

  return (
    <>
      <section className="sv-sec">
        <div className="sv-head">
          <h2 className="sv-h">{t('People')}</h2>
          {limit != null && (
            <span className="sv-seats" title={t('{n} of the {limit} accounts this server allows are active', { n: activeCount, limit })}>
              <span className="sv-mono"><b>{formatNumber(activeCount)}</b> {tp('of {limit} seat', 'of {limit} seats', limit, { limit: formatNumber(limit) })}</span>
              <span className="sv-line"><i style={{ width: `${Math.min(100, Math.round((activeCount / limit) * 100))}%` }} /></span>
            </span>
          )}
          <span className="sv-grow" />
          {!adding && (
            <button type="button" className="btn btn--quiet-accent btn--sm" disabled={full || !!busy}
              onClick={() => { setAdding(true); setConfirming(null); setNotice(null); }}>
              {t('Add person')}
            </button>
          )}
        </div>

        {full && !adding && (
          <p className="sv-note">
            {tp('Every seat is taken: this server allows at most {n} active account. Deactivate someone to free one.',
              'Every seat is taken: this server allows at most {n} active accounts. Deactivate someone to free one.', limit, { n: formatNumber(limit) })}
          </p>
        )}
        {error && <p className="sv-error" role="alert">{error}</p>}
        {notice && <p className="sv-note" role="status">{notice}</p>}
        {reveal && <TokenReveal {...reveal} onDismiss={() => setReveal(null)} />}
        {adding && <AddRow role={role} busy={busy === 'create'} onAdd={add} onCancel={() => setAdding(false)} />}

        <div className="sv-list" role="list">
          {accounts.map((a) => (confirming?.id === a.id ? confirmRow(a) : (
            <PersonRow key={a.id} account={a} you={you} role={role} full={full} busy={!!busy}
              onRole={(r) => act(`role-${a.id}`, () => updateAccount(a.id, { role: r }), nowRole(t, r, a.name))}
              onProgress={() => onViewProgress(a.id === you?.id ? null : a)}
              onLogs={can('readAllLogs') && onViewLogs ? () => onViewLogs(a.id === you?.id ? null : a) : null}
              onToken={async () => {
                setNotice(null);
                const issued = await run(`token-${a.id}`, () => issueToken(a.id, 'Issued from the app'));
                if (issued) setReveal({ title: t('A new token for {name}.', { name: a.name }), token: issued.token });
              }}
              onConfirm={(kind) => { setConfirming({ id: a.id, kind }); setAdding(false); }}
              onReactivate={() => act(`on-${a.id}`, () => updateAccount(a.id, { active: true }),
                t('{name} is active again, with the progress they had. They need a new token to sign in.', { name: a.name }))}
            />
          )))}
        </div>
      </section>

      {can('rotatePureToken') && (
        <PureToken busy={busy === 'pure'} onRotate={async () => {
          setNotice(null);
          const result = await run('pure', () => rotatePureToken());
          if (result) setReveal({ title: t('The new pure token.'), token: result.token });
        }} />
      )}
    </>
  );
}

/** The token that proves ownership. The Author's alone, and last, because rotating it is drastic. */
function PureToken({ busy, onRotate }) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="sv-sec sv-sec--danger">
      <h2 className="sv-h">{t('Pure token')}</h2>
      <p className="sv-p">
        {t('The token that proves you own this vault. Rotating it mints a new one and stops every existing Author token working, including the one this app is using right now.')}
      </p>
      {confirming ? (
        <div className="sv-confirm" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirming(false); } }}>
          <p>
            <b>{t('Rotate the pure token?')}</b>{' '}
            {t('Every Author token stops working immediately, including this session’s. Copy the new one before closing the panel, or you will need terminal access to recover.')}
          </p>
          <div className="sv-confirm__acts">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(false)} autoFocus>{t('Cancel')}</button>
            <button type="button" className="btn btn--danger btn--sm" disabled={busy}
              onClick={async () => { setConfirming(false); await onRotate(); }}>{t('Rotate')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn--danger-quiet btn--sm" disabled={busy} onClick={() => setConfirming(true)}>
          {t('Rotate pure token')}
        </button>
      )}
    </section>
  );
}

export default function Server({ connection, onViewProgress, onViewLogs }) {
  const { t, tp, formatNumber } = useT();
  const { can, account, role, loading } = useSession();
  const manage = can('manageAccounts');
  const people = useAccounts(manage);
  const [info, setInfo] = useState(null);
  const [infoError, setInfoError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getVaultIdentity()
      .then((v) => { if (!cancelled) setInfo(v); })
      .catch((e) => { if (!cancelled) setInfoError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <LoadingState message={t('Loading…')} />;

  const host = connection?.url?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const update = info?.update?.available ? info.update : null;

  return (
    <div className="sv-view">
      <article className="sv-report">
        <div className="sv-eyebrow">{[info?.vaultName, host].filter(Boolean).join(' · ')}</div>
        <h1 className="sv-title">{t('Server Management')}</h1>
        <p className="sv-lede">
          {account && <Rich text={signedInAs(t, role)} values={{ name: <b>{account.name}</b> }} />}
          {manage && !people.loading && ` ${people.limit != null
            ? tp('{n} of the {limit} seats on this server is in use.', '{n} of the {limit} seats on this server are in use.', people.activeCount, { n: formatNumber(people.activeCount), limit: formatNumber(people.limit) })
            : tp('{n} person has access.', '{n} people have access.', people.activeCount, { n: formatNumber(people.activeCount) })}`}
        </p>
        {update && (
          <p className="sv-update">
            {t('Version {version} is available.', { version: update.latest })}{' '}
            {update.url && <a href={update.url} target="_blank" rel="noreferrer">{t('Release notes')}</a>}
          </p>
        )}
        {infoError && <p className="sv-error" role="alert">{infoError}</p>}

        <YouHere info={info} connection={connection} />
        {manage && <People people={people} onViewProgress={onViewProgress} onViewLogs={onViewLogs} />}
      </article>
    </div>
  );
}
