/**
 * The first-run wizard's state: the step, the form, and submitting it to
 * Electron main, which writes config.json and creates the first vault.
 *
 * In a preview (`--onboarding` over an existing config) main writes nothing, and neither
 * does this: the scheduler choice stays where it was. Either way the welcome tour is
 * cleared to run next, so finishing the wizard hands over to it as a first run does.
 */

import { useState, useEffect } from 'react';
import { completeSetup, isSetupPreview } from '../../api/desktop';
import { useT } from '../../translations/index';
import { configFromForm } from './validation.js';

export default function useSetupWizard(onComplete) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    vaultName: 'dreams', isCustomPath: false, customPath: '', port: 50500, logFormat: 'dev', algorithm: 'sm2', userName: '', userEmail: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('fb-theme') ?? 'light-workbench';
    document.documentElement.setAttribute('data-theme', saved);
    isSetupPreview().then(setPreview).catch(() => {});
  }, []);

  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    let result;
    try {
      result = await completeSetup(configFromForm(form));
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.ok) {
      if (!result.preview) localStorage.setItem('fb-srs-algorithm', form.algorithm);
      localStorage.removeItem('fb-onboarding-seen');
      await onComplete();
    } else {
      setSubmitError(result?.error ?? t('Setup failed. Check the path and try again.'));
      setSubmitting(false);
    }
  };

  return { step, setStep, form, change, submitting, submitError, submit, preview };
}
