/**
 * The small pieces every tree row shares: the inline create box, the reading
 * progress badge, and the rename input.
 */

import { useState, useRef } from "react";
import IconFolder from "../../icons/IconFolder";
import IconFile from "../../icons/IconFile";
import { useT } from "../../../translations/index";
import { sanitizeName, reservedNameError, newItemName } from "./names.js";

/** The editable name of a node mid-rename. */
export function RenameInput({ inputProps }) {
  const { t } = useT();
  return (
    <input
      className="fe-rename-input field field--sm"
      autoFocus
      aria-label={t("New name")}
      {...inputProps}
    />
  );
}

/** A new file or folder being named in place; Enter or blur commits, Escape cancels. */
export function InlineCreate({ type, onConfirm, onCancel }) {
  const { t } = useT();
  const [name, setName] = useState(
    type === "folder" ? t("New Folder") : t("new_file"),
  );
  const committed = useRef(false);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const finalName = newItemName(name, type);
    if (!finalName) {
      onCancel();
      return;
    }
    const err = reservedNameError(finalName, type, t);
    if (err) {
      window.alert(err);
      onCancel();
      return;
    }
    onConfirm(finalName);
  };

  return (
    <div
      className={type === "folder" ? "fe-folder" : "fe-file"}
      style={{ pointerEvents: "none" }}
    >
      {type === "folder" && <span className="fe-chevron" />}
      {type === "folder" ? (
        <span className="fe-folder-icon">
          <IconFolder size={14} />
        </span>
      ) : (
        <IconFile size={14} />
      )}
      <span className="fe-item-label" style={{ pointerEvents: "auto" }}>
        <input
          className="fe-rename-input field field--sm"
          value={name}
          autoFocus
          aria-label={t("New name")}
          onChange={(e) => setName(sanitizeName(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") onCancel();
            e.stopPropagation();
          }}
          onBlur={commit}
          onFocus={(e) => e.target.select()}
          onClick={(e) => e.stopPropagation()}
        />
      </span>
    </div>
  );
}

/**
 * A document's reading position, or a folder's aggregate, as a thin bar and a
 * number. Nothing is drawn for something never opened: the point is to make a
 * large import navigable, which a row of empty bars would not.
 */
export function ProgressBadge({ progress, rollup }) {
  const { t } = useT();
  if (rollup) {
    if (!rollup.total || rollup.finished + rollup.inProgress === 0) return null;
    const pct = Math.round((rollup.percent ?? 0) * 100);
    const label = rollup.subscription
      ? t("{done} of {total} issues read", {
          done: rollup.finished,
          total: rollup.total,
        })
      : t("{done} of {total} read", {
          done: rollup.finished,
          total: rollup.total,
        });
    return (
      <span className="fe-progress" title={label}>
        <span className="fe-progress-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="fe-progress-text">
          {rollup.finished}/{rollup.total}
        </span>
      </span>
    );
  }
  if (!progress) return null;
  const pct =
    progress.furthestPercent != null
      ? Math.round(progress.furthestPercent * 100)
      : null;
  const label = progress.finished
    ? t("Finished")
    : pct != null
      ? t("{percent}% read", { percent: pct })
      : t("Started");
  return (
    <span
      className={`fe-progress${progress.finished ? " fe-progress--done" : ""}`}
      title={label}
    >
      <span className="fe-progress-bar">
        <span style={{ width: `${pct ?? 8}%` }} />
      </span>
      {pct != null && <span className="fe-progress-text">{pct}%</span>}
    </span>
  );
}
