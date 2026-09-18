/**
 * The scope controls above the card: what to study, what to leave out, how many
 * new cards, and whether to hold back unread material. Each is a vault-scoped
 * preference, and every change bumps `version` so the session knows to restart.
 */

import { useState, useEffect, useCallback } from 'react';
import { getPref, setPref, getBoolPref } from '../../prefs.js';
import { initialScope, withExclusion, withoutExclusion, mergeStudySession, sameScope } from './scope';

/**
 * @param {{ studySession: object|null, sessionDone: boolean }} args
 *   `sessionDone` lets a repeated hand-over of the same scope restart a finished session.
 */
export default function useTrainerScope({ studySession, sessionDone }) {
  const [scope, setScope] = useState(() => initialScope(studySession, getPref('fb-trainer-scope')));
  const [readOnly, setReadOnly] = useState(() => getBoolPref('fb-trainer-read-only', false));
  const [maxNew, setMaxNew] = useState(() => {
    const v = getPref('fb-srs-max-new');
    return v != null ? parseInt(v, 10) : 20;
  });
  const [maxNewDisplay, setMaxNewDisplay] = useState(() => getPref('fb-srs-max-new') ?? '20');
  const [showExclude, setShowExclude] = useState(false);
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

  const applyMaxNew = (display) => {
    const n = Math.max(0, parseInt(display) || 0);
    setMaxNew(n);
    setMaxNewDisplay(String(n));
    setPref('fb-srs-max-new', String(n));
    setVersion((v) => v + 1);
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
    maxNewDisplay,
    showExclude,
    setMaxNewDisplay,
    applyMaxNew,
    applyReadOnly,
    toggleExclude: () => setShowExclude((v) => !v),
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
