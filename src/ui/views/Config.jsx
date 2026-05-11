// A view with a simple formulary to edit the config. Not really that complex.
import { useState, useEffect } from 'react';

function useConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.flashback) {
      setError(new Error('window.flashback not available — run via Electron, not dev:web'));
      setLoading(false);
      return;
    }
    window.flashback.getConfig()
      .then(setConfig)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  return { config, setConfig, loading, error };
}

export default function ConfigView() {
  const { config, setConfig, loading, error } = useConfig();
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (config) setForm({ ...config });
  }, [config]);

  const handleChange = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setStatus('saving');
    const result = await window.flashback.setConfig(form);
    setStatus(result.ok ? 'saved' : `error: ${result.error}`);
    if (result.ok) setConfig(form);
  };

  const isDirty = form && config && JSON.stringify(form) !== JSON.stringify(config);

  if (loading) return <p>Loading config...</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!form) return null;

  return (
    <div>
      <h2>Config</h2>

      <table>
        <tbody>
          <tr>
            <td><label>Username</label></td>
            <td><input value={form.username ?? ''} onChange={e => handleChange('username', e.target.value)} /></td>
          </tr>
          <tr>
            <td><label>Port</label></td>
            <td><input type="number" value={form.port ?? 50500} onChange={e => handleChange('port', Number(e.target.value))} /></td>
          </tr>
          <tr>
            <td><label>Host</label></td>
            <td><input value={form.host ?? 'localhost'} onChange={e => handleChange('host', e.target.value)} /></td>
          </tr>
          <tr>
            <td><label>Custom workspace path</label></td>
            <td><input type="checkbox" checked={!!form.isCustomPath} onChange={e => handleChange('isCustomPath', e.target.checked)} /></td>
          </tr>
          {form.isCustomPath && (
            <tr>
              <td><label>Workspace path</label></td>
              <td><input value={form.customPath ?? ''} onChange={e => handleChange('customPath', e.target.value)} /></td>
            </tr>
          )}
        </tbody>
      </table>

      <p>
        <button onClick={handleSave} disabled={!isDirty || status === 'saving'}>
          Save
        </button>
        {' '}
        {status && <span>{status}</span>}
      </p>

      {isDirty && <p>⚠ Restart the app for port/host/path changes to take effect.</p>}
    </div>
  );
}
