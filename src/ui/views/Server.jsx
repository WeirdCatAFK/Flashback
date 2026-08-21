import { useState, useEffect, useCallback } from "react";
import "./Server.css";
import { getVaultIdentity } from "../api/vaults";
import {
  listAccounts, createAccount, updateAccount,
  getAccountProgress, issueToken, revokeToken, rotatePureToken,
} from "../api/accounts";
import { LoadingState, ErrorState } from "../components/shared/StateView";
import { useConfirm } from "../components/shared/ConfirmDialog";
import { useSession } from "../sessionContext.js";
import { ROLES, ROLE_ORDER } from "../../shared/roles.js";
import { useT } from "../translations";

/**
 * Server — who you are on this vault, and (for an admin) who else is.
 *
 * Shown only when connected to a remote. A local vault has exactly one account, it is the
 * Author, and every panel below would either be empty or tell you what you already know.
 *
 * The view is the answer to the question a shared vault provokes and nothing else answers:
 * *why does this app look different here than it does at home?* Everywhere else in M5 the UI
 * quietly stops offering what your role cannot do; this is the one place that says so out
 * loud, names your role, and shows what the other roles are.
 *
 * Each section degrades rather than disappears wholesale — a Reader still sees which server
 * they are on and what they are, they just do not see other people.
 */

const roleLabels = (t) => ({
  [ROLES.READER]:       t("Reader"),
  [ROLES.COLLABORATOR]: t("Collaborator"),
  [ROLES.ADMIN]:        t("Admin"),
  [ROLES.AUTHOR]:       t("Author"),
});

const roleBlurbs = (t) => ({
  [ROLES.READER]:       t("Studies the vault. Progress is yours alone; you cannot change the material."),
  [ROLES.COLLABORATOR]: t("Annotates documents that already exist — highlights, tags and cards. No new documents, no imports."),
  [ROLES.ADMIN]:        t("Runs the vault: creates and imports documents, and manages who has access."),
  [ROLES.AUTHOR]:       t("Owns the files. Can roll back history and rebuild the index. Exactly one per server."),
});

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * A token, shown once and never again.
 *
 * The plaintext exists only in the response that created it — the store keeps a SHA-256 — so
 * this is deliberately obtrusive rather than a toast that can be missed. It stays until it is
 * dismissed, and says plainly that dismissing it loses the token.
 */
function TokenReveal({ token, notice, onDismiss }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  return (
    <div className="srv-token" role="alert">
      <p className="srv-token__notice">{notice || t("Copy this token now — it cannot be shown again.")}</p>
      <code className="srv-token__value">{token}</code>
      <div className="srv-token__actions">
        <button type="button" className="srv-btn srv-btn--primary"
          onClick={async () => {
            try { await navigator.clipboard.writeText(token); setCopied(true); } catch { /* clipboard blocked */ }
          }}>
          {copied ? t("Copied") : t("Copy")}
        </button>
        <button type="button" className="srv-btn" onClick={onDismiss}>{t("Done")}</button>
      </div>
    </div>
  );
}

// ── This server ───────────────────────────────────────────────────────────────

function ServerIdentity({ connection }) {
  const { t } = useT();
  const { account, role, error: sessionError } = useSession();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const labels = roleLabels(t);
  const blurbs = roleBlurbs(t);

  useEffect(() => {
    let cancelled = false;
    getVaultIdentity()
      .then((v) => { if (!cancelled) setInfo(v); })
      .catch((e) => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="srv-section">
      <h2 className="srv-h2">{t("This server")}</h2>

      <dl className="srv-facts">
        <dt>{t("Vault")}</dt><dd>{info?.vaultName ?? "—"}</dd>
        <dt>{t("Address")}</dt><dd className="srv-mono">{connection?.url ?? "—"}</dd>
        <dt>{t("You are")}</dt>
        <dd>
          {account ? (
            <>
              <strong>{account.name}</strong>
              <span className="srv-dim"> · {account.email}</span>
            </>
          ) : t("Unknown")}
        </dd>
        <dt>{t("Your role")}</dt>
        <dd>
          {role ? (
            <>
              <span className={`srv-role srv-role--${role}`}>{labels[role]}</span>
              <p className="srv-role__blurb">{blurbs[role]}</p>
            </>
          ) : (
            <span className="srv-dim">{sessionError || t("Unknown")}</span>
          )}
        </dd>
        <dt>{t("Version")}</dt>
        <dd className="srv-dim">
          {info?.appVersion ?? "—"}
          {info && <> · {t("schema")} {info.schemaVersion} · {t("files")} {info.canonicalVersion}</>}
        </dd>
      </dl>

      {error && <p className="srv-error">{error}</p>}
    </section>
  );
}

// ── People ────────────────────────────────────────────────────────────────────

function AccountRow({ account, you, canGrant, onChangeRole, onDeactivate, onIssueToken, onRevoke, onShowProgress, busy }) {
  const { t } = useT();
  const labels = roleLabels(t);
  const isYou = account.id === you?.id;
  const isAuthor = account.role === ROLES.AUTHOR;
  const tokens = account.tokens ?? [];
  const live = tokens.filter((tk) => tk.active);

  return (
    <tr className={account.active ? "" : "srv-row--inactive"}>
      <td>
        {account.name}{isYou && <span className="srv-you"> ({t("you")})</span>}
        <div className="srv-dim srv-sub">{account.email}</div>
      </td>
      <td>
        {/* The Author cannot be demoted, and an admin may only ever grant Reader. Both are
            enforced server-side; the select simply does not offer what would be refused. */}
        {isAuthor || !canGrant(account.role) ? (
          <span className={`srv-role srv-role--${account.role}`}>{labels[account.role]}</span>
        ) : (
          <select className="srv-select" value={account.role} disabled={!!busy}
            onChange={(e) => onChangeRole(account, e.target.value)}>
            {ROLE_ORDER.filter((r) => r !== ROLES.AUTHOR && canGrant(r)).map((r) => (
              <option key={r} value={r}>{labels[r]}</option>
            ))}
          </select>
        )}
      </td>
      <td className="srv-dim">{live.length}</td>
      <td className="srv-dim">{fmtDate(account.createdAt)}</td>
      <td className="srv-actions">
        <button type="button" className="srv-btn srv-btn--sm" disabled={!!busy}
          onClick={() => onShowProgress(account)}>{t("Progress")}</button>
        <button type="button" className="srv-btn srv-btn--sm" disabled={!!busy}
          onClick={() => onIssueToken(account)}>{t("New token")}</button>
        {live.length > 0 && (
          <button type="button" className="srv-btn srv-btn--sm srv-btn--danger" disabled={!!busy}
            onClick={() => onRevoke(account, live)}>{t("Revoke")}</button>
        )}
        {!isAuthor && !isYou && account.active && (
          <button type="button" className="srv-btn srv-btn--sm" disabled={!!busy}
            onClick={() => onDeactivate(account)}>{t("Deactivate")}</button>
        )}
      </td>
    </tr>
  );
}

function People({ onProgress }) {
  const { t } = useT();
  const { can, role } = useSession();
  const confirm = useConfirm();
  const labels = roleLabels(t);

  const [accounts, setAccounts] = useState([]);
  const [you, setYou] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reveal, setReveal] = useState(null);
  const [form, setForm] = useState({ name: "", email: "", role: ROLES.READER });
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await listAccounts();
      setAccounts(data.accounts ?? []);
      setYou(data.you ?? null);
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // An admin may grant no more than Reader; the Author may grant anything below Author.
  const canGrant = useCallback(
    (target) => (role === ROLES.AUTHOR ? target !== ROLES.AUTHOR : target === ROLES.READER),
    [role],
  );

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); setError(null); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(null); await refresh(); }
  };

  if (loading) return <LoadingState message={t("Loading accounts…")} />;

  return (
    <section className="srv-section">
      <div className="srv-section__head">
        <h2 className="srv-h2">{t("People")}</h2>
        <button type="button" className="srv-btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? t("Cancel") : t("Add person")}
        </button>
      </div>

      {error && <p className="srv-error">{error}</p>}
      {reveal && <TokenReveal {...reveal} onDismiss={() => setReveal(null)} />}

      {showForm && (
        <div className="srv-form">
          <input className="srv-input" placeholder={t("Name")} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="srv-input" placeholder={t("Email")} type="email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select className="srv-select" value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLE_ORDER.filter((r) => r !== ROLES.AUTHOR && canGrant(r)).map((r) => (
              <option key={r} value={r}>{labels[r]}</option>
            ))}
          </select>
          <button type="button" className="srv-btn srv-btn--primary" disabled={busy === "create"}
            onClick={() => run("create", async () => {
              await createAccount(form);
              setForm({ name: "", email: "", role: ROLES.READER });
              setShowForm(false);
            })}>
            {t("Create")}
          </button>
        </div>
      )}

      <table className="srv-table">
        <thead>
          <tr>
            <th>{t("Person")}</th><th>{t("Role")}</th><th>{t("Tokens")}</th>
            <th>{t("Added")}</th><th />
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <AccountRow
              key={a.id} account={a} you={you} canGrant={canGrant} busy={busy}
              onShowProgress={onProgress}
              onChangeRole={(acc, r) => run(`role-${acc.id}`, () => updateAccount(acc.id, { role: r }))}
              onDeactivate={async (acc) => {
                if (!(await confirm({
                  title: t("Deactivate this person?"),
                  message: t("Every token they hold stops working immediately. Their study progress is kept, so reactivating resumes rather than restarts."),
                  confirmLabel: t("Deactivate"),
                  tone: "danger",
                }))) return;
                run(`off-${acc.id}`, () => updateAccount(acc.id, { active: false }));
              }}
              onIssueToken={(acc) => run(`token-${acc.id}`, async () => {
                const result = await issueToken(acc.id, "Issued from the app");
                setReveal({ token: result.token, notice: result.notice });
              })}
              onRevoke={async (acc, live) => {
                if (!(await confirm({
                  title: t("Revoke this person's tokens?"),
                  message: t("They lose access immediately and will need a new token to return."),
                  confirmLabel: t("Revoke"),
                  tone: "danger",
                }))) return;
                run(`revoke-${acc.id}`, async () => {
                  for (const tk of live) await revokeToken(tk.id);
                });
              }}
            />
          ))}
        </tbody>
      </table>

      {can("rotatePureToken") && (
        <div className="srv-danger">
          <h3 className="srv-h3">{t("Pure token")}</h3>
          <p className="srv-dim">
            {t("The token that proves you own this vault. Rotating it mints a new one and stops every existing Author token working — including the one this app is using right now.")}
          </p>
          <button type="button" className="srv-btn srv-btn--danger" disabled={busy === "pure"}
            onClick={async () => {
              if (!(await confirm({
                title: t("Rotate the pure token?"),
                message: t("Every Author token stops working immediately, including this session's. Copy the new one before closing the dialog or you will need terminal access to recover."),
                confirmLabel: t("Rotate"),
                tone: "danger",
              }))) return;
              run("pure", async () => {
                const result = await rotatePureToken();
                setReveal({ token: result.token, notice: result.notice });
              });
            }}>
            {t("Rotate pure token")}
          </button>
        </div>
      )}

    </section>
  );
}

// ── One person's progress ─────────────────────────────────────────────────────

function Progress({ account, onClose }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    getAccountProgress(account.id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [account.id]);

  const totals = data?.statistics?.totals ?? null;

  return (
    <section className="srv-section">
      <div className="srv-section__head">
        <h2 className="srv-h2">{t("Progress")} — {account.name}</h2>
        <button type="button" className="srv-btn" onClick={onClose}>{t("Close")}</button>
      </div>

      {error && <ErrorState error={error} />}
      {!data && !error && <LoadingState message={t("Loading progress…")} />}

      {totals && (
        <>
          <div className="srv-stats">
            <div className="srv-stat"><span className="srv-stat__n">{totals.reviews ?? 0}</span>{t("reviews")}</div>
            <div className="srv-stat"><span className="srv-stat__n">{totals.cards ?? 0}</span>{t("cards")}</div>
            <div className="srv-stat"><span className="srv-stat__n">{totals.daysStudied ?? 0}</span>{t("days studied")}</div>
            <div className="srv-stat">
              <span className="srv-stat__n">
                {totals.retentionAll == null ? "—" : `${Math.round(totals.retentionAll * 100)}%`}
              </span>{t("retention")}
            </div>
          </div>
          <p className="srv-dim srv-note">
            {/* Worth stating: the Author's schedule is stored under a sentinel rather than
                their account id, so this panel is reading a different key for them. */}
            {t("This is their own schedule. Nobody's reviews move anyone else's due list.")}
          </p>
        </>
      )}
    </section>
  );
}

// ── The view ──────────────────────────────────────────────────────────────────

export default function Server({ connection }) {
  const { t } = useT();
  const { can, loading } = useSession();
  const [progressFor, setProgressFor] = useState(null);

  if (loading) return <LoadingState message={t("Loading…")} />;

  return (
    <div className="srv-view">
      <ServerIdentity connection={connection} />

      {can("manageAccounts") ? (
        progressFor
          ? <Progress account={progressFor} onClose={() => setProgressFor(null)} />
          : <People onProgress={setProgressFor} />
      ) : (
        <section className="srv-section">
          <h2 className="srv-h2">{t("People")}</h2>
          <p className="srv-dim">
            {t("Managing who can reach this server is an admin's job. Ask whoever gave you your token if you need a different role.")}
          </p>
        </section>
      )}
    </div>
  );
}
