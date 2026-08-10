import { useEffect } from 'react';
import { fixedShortcutGroups, keybindingActions, formatKeyLabel } from '../keybindings';
import useKeybindings from '../hooks/useKeybindings';
import { useT } from '../translations';
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

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fixedGroups = fixedShortcutGroups(t).map(g => ({
    title: g.group,
    rows: g.shortcuts.map(s => ({ label: s.label, combos: s.keys })),
  }));

  const rebindableGroups = keybindingActions(t).map(g => ({
    title: g.group,
    rows: g.actions.map(a => ({
      label: a.label,
      combos: (kbMap[a.id] ?? a.default).map(k => [formatKeyLabel(k)]),
    })),
  }));

  const allGroups = [...fixedGroups, ...rebindableGroups];

  return (
    <div
      className="so-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="so-panel" role="dialog" aria-label={t('Keyboard shortcuts')} aria-modal="true">
        <div className="so-header">
          <span className="so-title">{t('Keyboard Shortcuts')}</span>
          <button type="button" className="so-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </div>
        <div className="so-body">
          {allGroups.map(({ title, rows }) => (
            <div key={title} className="so-group">
              <div className="so-group-title">{title}</div>
              {rows.map(row => (
                <ShortcutRow key={row.label} label={row.label} combos={row.combos} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
