import { useState } from 'react';
import { getPref, setPref, getNumberPref } from './prefs.js';

export default function useSrsPrefs() {
  const [algorithm, setAlgorithmState] = useState(
    () => getPref('fb-srs-algorithm') ?? 'sm2',
  );
  const [maxNew, setMaxNewState] = useState(
    () => getNumberPref('fb-srs-max-new', 20),
  );
  const [retention, setRetentionState] = useState(
    () => getNumberPref('fb-fsrs-retention', 0.9) || 0.9,
  );
  const [order, setOrderState] = useState(
    () => getPref('fb-trainer-order') ?? 'interleaved',
  );

  const applyAlgorithm = (v) => {
    setPref('fb-srs-algorithm', v);
    setAlgorithmState(v);
  };
  const setOrder = (v) => {
    setPref('fb-trainer-order', v);
    setOrderState(v);
  };
  const setMaxNew = (v) => {
    const n = Math.max(0, Math.min(200, Number(v) || 0));
    setPref('fb-srs-max-new', String(n));
    setMaxNewState(n);
  };
  const setRetention = (v) => {
    const r = Math.max(0.7, Math.min(0.97, Number(v) || 0.9));
    setPref('fb-fsrs-retention', String(r));
    setRetentionState(r);
  };

  return { algorithm, applyAlgorithm, maxNew, setMaxNew, retention, setRetention, order, setOrder };
}

export function useDiaryPref() {
  const [enabled, setEnabledState] = useState(
    () => getPref('fb-diary-enabled') === '1',
  );
  const setEnabled = (v) => {
    setPref('fb-diary-enabled', v ? '1' : '0');
    setEnabledState(v);
  };
  return { enabled, setEnabled };
}
