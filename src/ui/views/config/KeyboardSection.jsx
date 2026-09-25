/**
 * KeyboardSection — every rebindable action (keybindings.js) as a row with its keys:
 * Change records the next key pressed (Escape cancels), Reset appears once a binding
 * differs from its default. Then the shortcuts that cannot be changed, under "Always", so
 * the whole keyboard is in one place. A group's heading shows only while one of its rows
 * does, so a search for "undo" is not a list of empty headings.
 */

import { useEffect, useState } from 'react';
import { keybindingActions, fixedShortcutGroups, saveKeybinding, resetKeybinding, resetAllKeybindings, eventKeyName, formatKeyLabel, MODIFIER_KEYS } from '../../keybindings';
import useKeybindings from '../../hooks/useKeybindings';
import { useT } from '../../translations/index';
import ConfigRow from './ConfigRow';
import { useRows, useSearching } from './rowsContext.js';

const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

export default function KeyboardSection() {
  const { t } = useT();
  const map = useKeybindings();
  const { only } = useRows();
  const searching = useSearching();
  const [recording, setRecording] = useState(null);

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      if (MODIFIER_KEYS.includes(e.key)) return;
      saveKeybinding(recording, [eventKeyName(e)]);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  const shows = (ids) => !only || ids.some((id) => only.has(id));
  const groups = keybindingActions(t);
  const changed = groups.flatMap((g) => g.actions).some((a) => !same(map[a.id], a.default));

  return (
    <>
      {groups.map((group) => shows(group.actions.map((a) => `key:${a.id}`)) && (
        <div key={group.group} className="cf-group">
          <div className="cf-group__label">{group.group}</div>
          {group.actions.map((a) => {
            const keys = map[a.id] ?? [];
            const isChanged = !same(keys, a.default);
            return (
              <ConfigRow key={a.id} id={`key:${a.id}`}>
                <span className="cf-keys">
                  {recording === a.id
                    ? <span className="cf-capture">{t('Press a key…')}</span>
                    : keys.length ? keys.map((k) => <kbd key={k}>{formatKeyLabel(k)}</kbd>) : <span className="cf-none-key">{t('None')}</span>}
                  <button type="button" className="link-action" onClick={() => setRecording(recording === a.id ? null : a.id)}>
                    {recording === a.id ? t('Cancel') : t('Change')}
                  </button>
                  {isChanged && recording !== a.id && (
                    <button type="button" className="link-action" onClick={() => resetKeybinding(a.id)} title={t('Back to {keys}', { keys: a.default.map(formatKeyLabel).join(', ') || t('None') })}>
                      {t('Reset')}
                    </button>
                  )}
                </span>
              </ConfigRow>
            );
          })}
        </div>
      ))}

      {fixedShortcutGroups(t).map((group) => {
        const ids = group.shortcuts.map((_, i) => `fixed:${group.group}:${i}`);
        return shows(ids) && (
          <div key={group.group} className="cf-group">
            <div className="cf-group__label">{t('Always · {group}', { group: group.group })}</div>
            {group.shortcuts.map((s, i) => (
              <ConfigRow key={ids[i]} id={ids[i]}>
                <span className="cf-keys">
                  {s.keys.map((combo) => <kbd key={combo.join('+')}>{combo.join('+')}</kbd>)}
                </span>
              </ConfigRow>
            ))}
          </div>
        );
      })}

      {changed && !searching && (
        <div className="cf-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={resetAllKeybindings}>{t('Reset all to defaults')}</button>
        </div>
      )}
    </>
  );
}
