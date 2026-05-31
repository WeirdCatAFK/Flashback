import { useEffect, useState } from 'react';
import {
  KEYBINDING_ACTIONS,
  saveKeybinding,
  resetKeybinding,
  resetAllKeybindings,
  eventKeyName,
  formatKeyLabel,
} from '../keybindings';
import useKeybindings from '../hooks/useKeybindings';
import './KeybindingsEditor.css';

// Collapsible editor (like the theme editor) that lists every registered action
// with its current key(s) and lets the user rebind by capturing the next
// keypress. Reads the live map via the hook; writes go through the keybindings
// module. The list grows as features register more actions, hence the collapse.
export default function KeybindingsEditor() {
  const map = useKeybindings();
  const [recording, setRecording] = useState(null); // actionId being rebound, or null
  const [open, setOpen] = useState(() => localStorage.getItem('fb-kb-open') === 'true');

  const toggleOpen = () => {
    setOpen((o) => {
      localStorage.setItem('fb-kb-open', String(!o));
      return !o;
    });
  };

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      saveKeybinding(recording, [eventKeyName(e)]);
      setRecording(null);
    };
    // Capture phase so the pressed key is consumed here, not by the app.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  // Stop recording if the panel is collapsed mid-capture.
  useEffect(() => {
    if (!open && recording) setRecording(null);
  }, [open, recording]);

  return (
    <div className="kb-editor">
      <button className="kb-toggle" onClick={toggleOpen} aria-expanded={open}>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
        >
          <polyline points="4,2 9,6 4,10" />
        </svg>
        Keybindings
      </button>

      {open && (
        <div className="kb-content">
          {KEYBINDING_ACTIONS.map((group) => (
            <div key={group.group} className="kb-group">
              <span className="kb-group-title">{group.group}</span>
              {group.actions.map((a) => (
                <div key={a.id} className="kb-action">
                  <span className="kb-action-label">{a.label}</span>
                  <div className="kb-row">
                    <span className="kb-keys">
                      {recording === a.id
                        ? <span className="kb-recording">Press a key…</span>
                        : (map[a.id] ?? []).map((k) => <kbd key={k} className="kb-cap">{formatKeyLabel(k)}</kbd>)}
                    </span>
                    <button
                      className={`kb-btn${recording === a.id ? ' kb-btn--recording' : ''}`}
                      onClick={() => setRecording(recording === a.id ? null : a.id)}
                    >
                      {recording === a.id ? 'Cancel' : 'Rebind'}
                    </button>
                    <button className="kb-btn kb-btn--icon" title="Reset to default" onClick={() => resetKeybinding(a.id)}>
                      ↺
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
          <button className="kb-btn kb-reset-all" onClick={resetAllKeybindings}>
            Reset all to defaults
          </button>
        </div>
      )}
    </div>
  );
}
