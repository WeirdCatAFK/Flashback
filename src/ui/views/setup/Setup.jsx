/**
 * Setup — the first-run wizard shown instead of the app when there is no
 * config.json. Steps are in SetupSteps.jsx; state and the write are in
 * useSetupWizard.js. It renders its own TitleBar because the shell does not exist yet.
 *
 * `npm run dev:onboarding` shows it over an existing config as a preview: the steps are
 * the same, the eyebrow says so, and finishing writes nothing (Electron main's
 * `isSetupPreview`).
 */

import TitleBar from '../../components/shell/TitleBar';
import { useT } from '../../translations/index';
import useSetupWizard from './useSetupWizard';
import { StepLadder, StepWelcome, StepVault, StepIdentity, StepReady } from './SetupSteps';
import './Setup.css';
import '../../App.css';

export default function SetupView({ onComplete }) {
  const { t } = useT();
  const { step, setStep, form, change, submitting, submitError, submit, preview } = useSetupWizard(onComplete);
  const labels = [t('Welcome'), t('Vault'), t('You'), t('Review')];

  return (
    <div className="ob-shell">
      <TitleBar screen={t('Setup')} />
      <main className="ob-body">
        <div className="ob-page">
          <div className="ob-top">
            <StepLadder step={step} labels={labels} />
            {preview && <p className="ob-eyebrow">{t('Preview · nothing is written')}</p>}
          </div>

          {step === 0 && <StepWelcome onNext={() => setStep(1)} />}
          {step === 1 && (
            <StepVault state={form} onChange={change} onNext={() => setStep(2)} onBack={() => setStep(0)} />
          )}
          {step === 2 && (
            <StepIdentity state={form} onChange={change} onNext={() => setStep(3)} onBack={() => setStep(1)} />
          )}
          {step === 3 && (
            <StepReady
              state={form}
              onBack={() => setStep(2)}
              onSubmit={submit}
              submitting={submitting}
              submitError={submitError}
              preview={preview}
            />
          )}
        </div>
      </main>
    </div>
  );
}
