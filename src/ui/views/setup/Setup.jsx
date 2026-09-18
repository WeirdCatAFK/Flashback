/**
 * Setup — the first-run wizard shown instead of the app when there is no
 * config.json. Steps are in SetupSteps.jsx; state and the write are in
 * useSetupWizard.js. It renders its own TitleBar because the shell does not exist yet.
 */

import TitleBar from '../../components/shell/TitleBar';
import useSetupWizard, { STEPS } from './useSetupWizard';
import { StepDots, StepWelcome, StepVault, StepIdentity, StepReady } from './SetupSteps';
import './Setup.css';
import '../../App.css';

export default function SetupView({ onComplete }) {
  const { step, setStep, form, change: handleChange, submitting, submitError, submit: handleSubmit } = useSetupWizard(onComplete);
  const TOTAL = STEPS;

  return (
    <div className="ob-shell">
      <TitleBar />
      <div className="ob-body">
        <div className="ob-card">
          <StepDots step={step} total={TOTAL} />

          {step === 0 && (
            <StepWelcome onNext={() => setStep(1)} />
          )}
          {step === 1 && (
            <StepVault
              state={form}
              onChange={handleChange}
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
            />
          )}
          {step === 2 && (
            <StepIdentity
              state={form}
              onChange={handleChange}
              onNext={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && (
            <StepReady
              state={form}
              onBack={() => setStep(2)}
              onSubmit={handleSubmit}
              submitting={submitting}
              submitError={submitError}
            />
          )}
        </div>
      </div>
    </div>
  );
}
