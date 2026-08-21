/**
 * RoleBadge — your role on the vault in the title bar, beside its name.
 *
 * It sits here for the same reason the vault name does. `TitleBar` already argues that the
 * active vault must be visible at all times because it is *the part that changes*; on a shared
 * server your role is the other part that changes, and it is the answer to the question the UI
 * would otherwise provoke silently — "why is there no New Document button?". Without it, a
 * Reader's app just looks broken.
 *
 * **Shown only on a remote.** On a local vault there is one account, it is the Author, and a
 * badge reading "Author" next to your own vault name is noise that teaches nobody anything.
 *
 * It is a label, not a control. Nothing to click: what a role means, and who could change it,
 * belongs in the Server view where there is room to say it.
 */

import { useT } from '../translations';
import { useSession } from '../sessionContext.js';
import { roleLabel } from '../roleLabels.js';
import './RoleBadge.css';

export default function RoleBadge({ connection }) {
    const { t } = useT();
    const { role, loading, error } = useSession();

    if (connection?.kind !== 'remote') return null;

    // Distinguish "still asking" from "asked and got nothing". The second is worth showing:
    // it is why the app looks limited, and hiding it would leave the cause invisible.
    if (loading) return null;
    if (error || !role) {
        return (
            <span className="role-badge role-badge--unknown" title={error || t('Could not read your role on this server.')}>
                {t('Role unknown')}
            </span>
        );
    }

    return (
        <span
            className={`role-badge role-badge--${role}`}
            title={t('Your role on this server')}
        >
            {roleLabel(t, role)}
        </span>
    );
}
