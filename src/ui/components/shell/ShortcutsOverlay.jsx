/**
 * ShortcutsOverlay — every keyboard shortcut in one dialog: the fixed ones,
 * then the rebindable actions with whatever keys the user has set.
 */

import Modal from '../base/Modal';
import { fixedShortcutGroups, keybindingActions, keyParts } from '../../keybindings';
import useKeybindings from '../../hooks/useKeybindings';
import { useT } from '../../translations/index';
import './ShortcutsOverlay.css';

function KeyCombo({ parts }) {
  return (
    <span className="so-combo">
      {parts.map((part, i) => (
        <span key={i} className="so-combo-inner">
          {i > 0 && <span className="so-plus">+</span>}
          <kbd className="so-key">{part}</kbd>
        </span>
      ))}
    </span>
  );
}

function ShortcutRow({ label, combos }) {
  return (
    <div className="so-row">
      <span className="so-row-label">{label}</span>
      <span className="so-row-keys">
        {combos.map((parts, i) => (
          <span key={i}>
            {i > 0 && <span className="so-alt-sep">·</span>}
            <KeyCombo parts={parts} />
          </span>
        ))}
      </span>
    </div>
  );
}

export default function ShortcutsOverlay({ onClose }) {
  const { t } = useT();
  const kbMap = useKeybindings();

  const groups = [
    ...fixedShortcutGroups(t).map((g) => ({ title: g.group, rows: g.shortcuts.map((s) => ({ label: s.label, combos: s.keys })) })),
    ...keybindingActions(t).map((g) => ({
      title: g.group,
      rows: g.actions.map((a) => ({ label: a.label, combos: (kbMap[a.id] ?? a.default).map((k) => keyParts(k)) })),
    })),
  ];

  return (
    <Modal title={t('Keyboard Shortcuts')} onClose={onClose} className="so-panel">
      {groups.map(({ title, rows }) => (
        <div key={title} className="so-group">
          <div className="eyebrow so-group-title">{title}</div>
          {rows.map((row) => <ShortcutRow key={row.label} label={row.label} combos={row.combos} />)}
        </div>
      ))}
    </Modal>
  );
}
