/**
 * ProgressScopePicker — whose progress Stats and Graph show. Renders nothing
 * unless the session may view others' progress and the server lists someone
 * other than the caller, so the desktop app never sees it.
 */

import { useEffect, useState } from "react";
import "./ProgressScopePicker.css";
import { listAccounts } from "../../api/accounts";
import { useCan } from "../../sessionContext.js";
import { roleLabel, progressScopeLabels } from "../../roleLabels.js";
import { useT } from "../../translations/index";

/**
 * The native <select> popup is an OS-level window sized to its longest option, so CSS on the
 * control cannot keep it inside the app frame — only the option text can. Names past this
 * length are cut in the list; the full name stays in the control's tooltip and the note.
 */
const OPTION_NAME_MAX = 28;
const clipName = (name) =>
  name.length > OPTION_NAME_MAX
    ? `${name.slice(0, OPTION_NAME_MAX - 1).trimEnd()}…`
    : name;

/**
 * Whose progress the Stats and Graph tabs show: you, or — for an Admin or the Author on a
 * shared vault — anyone else on it.
 *
 * Renders nothing unless the session holds `viewAllProgress` AND the server lists at least
 * one other active account (you are the "You" option, not a row). Hidden rather than disabled
 * on purpose (INTERFACE.md): looking at other people's schedules is categorically not a
 * Reader's, and on a local vault there is exactly one account, so the desktop app never shows
 * this at all. The list is fetched once per mount and any failure hides the control, which
 * fails closed the way the session itself does.
 *
 * The selection is not stored here. `App.jsx` owns it, like `connection`, so the choice made on
 * one tab carries to the other and resets when the connection changes.
 *
 * @param {{ value: {id: string, name: string, role: string}|null,
 *           onChange: (account: object|null) => void,
 *           className?: string,
 *           note?: boolean }} props
 *   `className` wraps the control so a host panel can slot it as one of its own sections
 *   without rendering an empty one when the picker hides; `note` adds a line naming whose
 *   progress is showing, for surfaces whose numbers do not say so themselves.
 */
export default function ProgressScopePicker({
  value,
  onChange,
  className,
  note = false,
}) {
  const { t } = useT();
  const allowed = useCan("viewAllProgress");
  const [accounts, setAccounts] = useState(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    listAccounts()
      .then((data) => {
        if (cancelled) return;
        const me = data.you?.id;
        setAccounts(
          (data.accounts ?? []).filter((a) => a.active && a.id !== me),
        );
      })
      .catch(() => {
        if (!cancelled) setAccounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed || !accounts || accounts.length === 0) return null;

  const labels = progressScopeLabels(t);
  const current =
    value && accounts.some((a) => a.id === value.id) ? value.id : "";

  return (
    <div className={className ? `scope-picker ${className}` : "scope-picker"}>
      <label className="scope-picker__control">
        <span className="scope-picker__label">{labels.pickerLabel}</span>
        <select
          className="scope-picker__select"
          value={current}
          title={value && current ? value.name : undefined}
          onChange={(e) => {
            const picked =
              accounts.find((a) => a.id === e.target.value) ?? null;
            onChange(
              picked
                ? { id: picked.id, name: picked.name, role: picked.role }
                : null,
            );
          }}
        >
          <option value="">{labels.you}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {clipName(a.name)} · {roleLabel(t, a.role)}
            </option>
          ))}
        </select>
      </label>
      {note && value && current && (
        <div className="scope-picker__note">{labels.viewing(value.name)}</div>
      )}
    </div>
  );
}
