/**
 * The FSRS optimizer: how many graded reviews exist, when the weights were last
 * fitted, and running the fit on demand with its before/after loss.
 */

import { useState, useEffect } from 'react';
import { optimizeFsrs, getFsrsInfo } from '../../api/srs';
import { useT } from '../../translations/index';

export default function useFsrsOptimizer() {
  const { t } = useT();
  const [info, setInfo] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    getFsrsInfo().then(setInfo).catch(() => setInfo(null));
  };
  useEffect(load, []);

  const enough = info && info.reviewCount >= info.minReviews;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await optimizeFsrs();
      setResult(res);
      load();
    } catch (e) {
      setError(e?.message ?? t('Optimization failed'));
    } finally {
      setRunning(false);
    }
  };

  return { info, running, result, error, enough, run };
}
