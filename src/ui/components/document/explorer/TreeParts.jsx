/**
 * The small pieces every tree row shares: the inline create box, the rename
 * input, the chevron, the card count and the read line.
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
      {type === "folder" ? <Chevron /> : <span className="fe-chevron-space" />}
      {type === "folder" ? <IconFolder /> : <IconFile />}
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
 * The thin line under a row's name: how far it has been read. Drawn only for
 * something opened — see readFacts. The words go in the row's tooltip.
 */
export function ReadLine({ facts }) {
  if (facts.value == null) return null;
  return (
    <span className={`fe-read${facts.finished ? " fe-read--done" : ""}`} aria-hidden="true">
      <i style={{ width: `${Math.round(facts.value * 100)}%` }} />
    </span>
  );
}

/** A card count: a small card outline and the number. Nothing for none. */
export function CardCount({ n }) {
  const { tp } = useT();
  if (!n) return null;
  return (
    <span className="fe-cards" aria-label={tp("{n} card", "{n} cards", n)}>
      <i aria-hidden="true" />
      {n}
    </span>
  );
}

/** The folder chevron, drawn; it turns when the folder opens. */
export function Chevron({ onClick }) {
  return (
    <span className="fe-chevron" onClick={onClick} aria-hidden="true">
      <svg viewBox="0 0 10 10">
        <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
