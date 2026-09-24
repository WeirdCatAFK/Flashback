/**
 * The scope controls above the card: what to study, what to leave out, how many
 * new cards, whether to hold back unread material, and how many due cards one
 * batch takes. Each is a vault-scoped preference. A change that alters which cards
 * are due bumps `version` so the session refetches; the batch size only re-slices
 * the cards already fetched, so it does not.
 */

import { useState, useEffect, useCallback } from 'react';
import { getPref, setPref, getBoolPref, getNumberPref } from '../../prefs.js';
import { initialScope, withExclusion, withoutExclusion, mergeStudySession, sameScope } from './scope';

/**
 * @param {{ studySession: object|null, sessionDone: boolean }} args
 *   `sessionDone` lets a repeated hand-over of the same scope restart a finished session.
 */
export default function useTrainerScope({ studySession, sessionDone }) {
  const [scope, setScope] = useState(() => initialScope(studySession, getPref('fb-trainer-scope')));
  const [readOnly, setReadOnly] = useState(() => getBoolPref('fb-trainer-read-only', false));
  const [maxNew, setMaxNew] = useState(() => getNumberPref('fb-srs-max-new', 20));
  const [batchSize, setBatchSize] = useState(() => getNumberPref('fb-trainer-batch', 0));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setPref('fb-trainer-scope', JSON.stringify(scope));
  }, [scope]);

  const rescope = useCallback((fn) => {
    setScope(fn);
    setVersion((v) => v + 1);
  }, []);

  const [prevStudySession, setPrevStudySession] = useState(studySession);
  if (prevStudySession !== studySession) {
    setPrevStudySession(studySession);
    if (studySession && (!sameScope(scope, studySession) || sessionDone)) {
      rescope((s) => mergeStudySession(s, studySession));
    }
  }

  const applyMaxNew = (value) => {
    const n = Math.max(0, parseInt(value, 10) || 0);
    setMaxNew(n);
    setPref('fb-srs-max-new', String(n));
    setVersion((v) => v + 1);
  };

  const applyBatch = (size) => {
    setBatchSize(size);
    setPref('fb-trainer-batch', String(size));
  };

  const applyReadOnly = (on) => {
    setReadOnly(on);
    setPref('fb-trainer-read-only', String(on));
    setVersion((v) => v + 1);
  };

  return {
    scope,
    version,
    readOnly,
    maxNew,
    batchSize,
    applyMaxNew,
    applyBatch,
    applyReadOnly,
    clearScope: () => rescope((s) => ({ ...s, folder: null, document: null, deck: null, deckName: null, tags: null, exclude: { folders: [], documents: [], decks: [], tags: [] } })),
    clearFolder: () => rescope((s) => ({ ...s, folder: null })),
    clearDocument: () => rescope((s) => ({ ...s, document: null })),
    clearDeck: () => rescope((s) => ({ ...s, deck: null, deckName: null })),
    applyFolder: (folder) => rescope((s) => ({ ...s, folder })),
    applyDocument: (document) => rescope((s) => ({ ...s, document })),
    applyDeck: ({ deck, deckName }) => rescope((s) => ({ ...s, deck, deckName })),
    applyTags: (tags) => rescope((s) => ({ ...s, tags: tags?.length ? tags : null })),
    addExclusion: (kind, value) => rescope((s) => withExclusion(s, kind, value)),
    removeExclusion: (kind, id) => rescope((s) => withoutExclusion(s, kind, id)),
  };
}
