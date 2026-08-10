import { useState } from 'react';
import { useT } from '../../../translations';
import './SourceUrlForm.css';

// Empty-state URL entry shown by the YouTube/clip renderers when a file was
// created without a source yet (e.g. via "New file"). onSubmit(url) returns a
// promise; on rejection the message is surfaced inline.
export default function SourceUrlForm({
  title,
  hint,
  placeholder = 'https://…',
  submitLabel,
  busyLabel,
  onSubmit,
}) {
  const { t } = useT();
  const [url, setUrl]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  // Defaulted here rather than in the parameter list: a default that calls t()
  // has to run inside the component to pick up a language switch.
  const submitText = submitLabel ?? t('Load');
  const busyText   = busyLabel   ?? t('Loading…');

  const submit = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(u);
    } catch (err) {
      setError(err?.message || t('Could not load that URL.'));
      setBusy(false);
    }
  };

  return (
    <div className="srcform">
      <div className="srcform-card">
        <h2 className="srcform-title">{title}</h2>
        {hint && <p className="srcform-hint">{hint}</p>}
        <div className="srcform-row">
          <input
            className="srcform-input"
            type="url"
            inputMode="url"
            placeholder={placeholder}
            value={url}
            autoFocus
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
          <button type="button" className="srcform-btn" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? busyText : submitText}
          </button>
        </div>
        {error && <p className="srcform-error">{error}</p>}
      </div>
    </div>
  );
}
