/**
 * Fetches the due queue for a scope and maps it into trainer cards. The reset on a
 * dependency change happens during render, so a stale result is never shown
 * between the change and the effect that refetches.
 */

import { useState, useEffect, useMemo } from 'react';
import { getDue } from '../../api/srs';
import { getPref } from '../../prefs.js';
import { mapApiCard } from './cards';

export default function useDueCards({ folder, document, deck, tags, exclude, readOnly, maxNew, refreshToken }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const tagsKey = tags ? tags.slice().sort().join(',') : '';
  const excludeKey = JSON.stringify(exclude ?? {});

  const [prevDeps, setPrevDeps] = useState({ folder, document, deck, tagsKey, excludeKey, readOnly, maxNew, refreshToken });
  if (prevDeps.folder !== folder || prevDeps.document !== document || prevDeps.deck !== deck ||
      prevDeps.tagsKey !== tagsKey || prevDeps.excludeKey !== excludeKey ||
      prevDeps.readOnly !== readOnly || prevDeps.maxNew !== maxNew ||
      prevDeps.refreshToken !== refreshToken) {
    setPrevDeps({ folder, document, deck, tagsKey, excludeKey, readOnly, maxNew, refreshToken });
    setLoading(true);
    setResult(null);
    setError(null);
  }

  useEffect(() => {
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
    const order = getPref('fb-trainer-order') ?? 'interleaved';
    const tagsArray = tagsKey ? tagsKey.split(',') : undefined;
    getDue({
      algorithm,
      maxNew,
      folder,
      document,
      deck,
      order,
      readOnly,
      exclude: JSON.parse(excludeKey),
      tags: tagsArray?.length ? tagsArray : undefined,
    })
      .then(setResult)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [folder, document, deck, tagsKey, excludeKey, readOnly, maxNew, refreshToken]);

  const cards = useMemo(() => {
    if (!result) return [];
    const queue = result.queue ?? [...result.due, ...result.new];
    const newHashes = new Set(result.new.map((c) => c.global_hash));
    return queue.map((c) => mapApiCard(c, newHashes.has(c.global_hash)));
  }, [result]);

  return { cards, result, loading, error, sessionId: result?.sessionId ?? null };
}
