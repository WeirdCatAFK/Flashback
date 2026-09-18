/**
 * The first-run wizard's state: the step, the form, and submitting it to
 * Electron main, which writes config.json and creates the first vault.
 */

import { useState, useEffect } from 'react';
import { completeSetup } from '../../api/desktop';
import { useT } from '../../translations/index';
import { configFromForm } from './validation.js';

export const STEPS = 4;

export default function useSetupWizard(onComplete) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    vaultName: 'dreams', isCustomPath: false, customPath: '', port: 50500, logFormat: 'dev', algorithm: 'sm2', userName: '', userEmail: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('fb-theme') ?? 'light-workbench';
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const change = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    const result = await completeSetup(configFromForm(form));
    if (result?.ok) {
      localStorage.setItem('fb-srs-algorithm', form.algorithm);
      await onComplete();
    } else {
      setSubmitError(result?.error ?? t('Setup failed. Check the path and try again.'));
      setSubmitting(false);
    }
  };

  return { step, setStep, form, change, submitting, submitError, submit };
}
