import { useEffect, useState } from "react";
import "./ProgressScopePicker.css";
import { listAccounts } from "../../api/accounts";
import { useCan } from "../../utils/sessionContext.js";
import { roleLabel, progressScopeLabels } from "../../utils/roleLabels.js";
import { useT } from "../../translations/index";

const OPTION_NAME_MAX = 28;
const clipName = (name) =>
  name.length > OPTION_NAME_MAX
    ? `${name.slice(0, OPTION_NAME_MAX - 1).trimEnd()}…`
    : name;

export default function ProgressScopePicker({
  value,
  onChange,
  className,
  note = false,
  capability = "viewAllProgress",
  label,
  everyone = false,
}) {
  const { t } = useT();
  const allowed = useCan(capability);
  const [accounts, setAccounts] = useState(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    listAccounts()
      .then((data) => {
        if (cancelled) return;
        const me = data.you?.id;
        setAccounts(
          (data.accounts ?? []).filter((a) => (everyone || a.active) && a.id !== me),
        );
      })
      .catch(() => {
        if (!cancelled) setAccounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, everyone]);

  if (!allowed || !accounts || accounts.length === 0) return null;

  const labels = progressScopeLabels(t);
  const current =
    value && accounts.some((a) => a.id === value.id) ? value.id : "";

  return (
    <div className={className ? `scope-picker ${className}` : "scope-picker"}>
      <label className="scope-picker__control">
        <span className="scope-picker__label">{label ?? labels.pickerLabel}</span>
        <select
          className="field field--sm scope-picker__select"
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
