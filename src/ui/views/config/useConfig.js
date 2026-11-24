import { useState, useEffect } from 'react';
import { getConfig, setConfig as writeConfig, isDesktop } from '../../api/desktop';

const RESTART_FIELDS = ['port', 'host'];
const SAVED_FLASH_MS = 2000;

export default function useConfig() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(isDesktop());
  const [error, setError] = useState(isDesktop() ? null : new Error('window.flashback not available — run via Electron, not dev:web'));
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [restartPending, setRestartPending] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    getConfig().then(setConfig).catch(setError).finally(() => setLoading(false));
  }, []);

  const [prevConfig, setPrevConfig] = useState(config);
  if (prevConfig !== config) {
    setPrevConfig(config);
    if (config) setForm({ ...config });
  }

  const change = (key, value) => {
    setRestartPending(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setStatus('saving');
    setRestartPending(false);
    const preSave = config;
    const result = await writeConfig(form);
    if (!result.ok) { setStatus(`error: ${result.error}`); return; }
    setConfig(form);
    setStatus('saved');
    setTimeout(() => setStatus((s) => (s === 'saved' ? null : s)), SAVED_FLASH_MS);
    if (preSave && RESTART_FIELDS.some((k) => form[k] !== preSave[k])) setRestartPending(true);
  };

  const writeField = async (key, value) => {
    if (!form) return;
    const next = { ...form, [key]: value };
    const result = await writeConfig(next);
    if (result?.ok) setConfig(next);
  };

  const isDirty = !!(form && config && JSON.stringify(form) !== JSON.stringify(config));
  return {
    config, form, loading, error, status, restartPending, isDirty,
    hasRestartDirty: isDirty && RESTART_FIELDS.some((k) => form[k] !== config[k]),
    change, save, writeField,
    discard: () => { if (config) setForm({ ...config }); setStatus(null); },
    dismissRestart: () => setRestartPending(false),
  };
}
