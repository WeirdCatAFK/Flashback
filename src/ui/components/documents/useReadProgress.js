import { useCallback, useEffect, useRef, useState } from 'react';
import { getProgress, setProgress, clearProgress } from '../../api/progress';

// How long a document must be open before it can acquire a reading position.
//
// Without this, single-clicking through a folder in preview tabs would stamp a position
// onto every file touched — which is worst in exactly the case this feature exists for, a
// freshly imported folder of hundreds of documents. A glance is not reading.
const MIN_DWELL_MS = 5000;

// Capture is continuous; writing is not. The renderer reports on every scroll, and this is
// how long the reports settle before one request goes out. Also flushed on unmount, on a
// path change, and when the tab is hidden, so closing a document never loses the last move.
const FLUSH_MS = 3000;

/** Have we actually moved, or is this the same place the document opened at? */
function samePlace(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reading position for one open document: loads it, hands it to the renderer to resume
 * from, and records where the reader gets to.
 *
 * Lives outside DocumentEditor because it owns real policy — the dwell guard, the write
 * debounce, and the auto-versus-manual distinction — none of which the editor should have
 * to hold while it is also managing tabs, drafts and selections.
 *
 * @param {string|null} path - the active document, or null.
 */
export function useReadProgress(path) {
  // undefined = still loading (renderers wait for it), null = never opened.
  const [initialProgress, setInitialProgress] = useState(undefined);
  const [resumeAt, setResumeAt] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  // The most recent auto report, so the bar can show a live position between writes.
  const [live, setLive] = useState(null);

  const pendingRef = useRef(null);      // the latest report, not yet written
  const timerRef = useRef(null);
  const openedAtRef = useRef(0);
  const startedAtRef = useRef(null);    // where the document opened, to detect real movement
  const pathRef = useRef(path);

  // Writes whatever is pending. Kept in a ref so the unmount effect can call the current
  // version without re-running (and re-flushing) every time a report arrives.
  const flushRef = useRef(() => {});
  flushRef.current = async () => {
    const job = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!job) return;
    try {
      await setProgress(job.path, job.body);
    } catch {
      // A lost position is not worth interrupting reading over. The next report retries.
    }
  };

  useEffect(() => {
    pathRef.current = path;
    setInitialProgress(undefined);
    setResumeAt(null);
    setDismissed(false);
    setLive(null);
    startedAtRef.current = null;
    openedAtRef.current = Date.now();
    if (!path) { setInitialProgress(null); return; }

    let live = true;
    getProgress(path)
      .then((p) => {
        if (!live) return;
        setInitialProgress(p ?? null);
        startedAtRef.current = p?.position ?? null;
        if (p?.position) setResumeAt(p);
      })
      .catch(() => { if (live) setInitialProgress(null); });

    return () => { live = false; };
  }, [path]);

  // Flush on unmount and whenever the document changes, so the last position of the
  // document being left behind is written before its path goes out of scope.
  useEffect(() => () => { flushRef.current(); }, [path]);

  // Switching away from the window (or quitting) is exactly when an unflushed position
  // would otherwise be lost.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  /**
   * The renderer's upward channel. Called freely — on every scroll or relocation — and
   * throttled here rather than at the call site.
   */
  const reportProgress = useCallback((reportPath, { unit, position, percent, total }) => {
    if (!reportPath || !unit || !position) return;
    if (reportPath !== pathRef.current) return;              // a stale renderer, mid-switch
    if (Date.now() - openedAtRef.current < MIN_DWELL_MS) return;
    if (samePlace(position, startedAtRef.current)) return;   // never moved from where it opened

    // The guard above asks "has the reader moved at all yet", and one report through is the
    // answer. Left standing it becomes a permanent blind spot instead: it holds the position
    // the document RESUMED at, so coming back to that page later — the most natural thing to
    // do with a bookmark — matched it again and the report was dropped, silently, for as long
    // as the tab stayed open.
    startedAtRef.current = null;

    // What the bar shows should be where the reader is, not where they were when the document
    // opened. The write is debounced by design; the readout must not be, or a position that is
    // being recorded correctly still looks frozen.
    setLive({ unit, position, percent: percent ?? null, total: total ?? null });

    pendingRef.current = { path: reportPath, body: { unit, position, percent, total, mode: 'auto' } };
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => { timerRef.current = null; flushRef.current(); }, FLUSH_MS);
    }
  }, []);

  /**
   * A deliberate position, from the toolbar: "set the mark here", "mark as finished".
   *
   * Always `manual`, which is what lets the furthest mark move BACKWARDS — an automatic
   * report can only ever advance it, so a correction has to come through here.
   */
  const setManualProgress = useCallback(async (body) => {
    if (!pathRef.current) return null;
    await flushRef.current();
    const res = await setProgress(pathRef.current, { ...body, mode: 'manual' });
    return res?.progress ?? null;
  }, []);

  const clear = useCallback(async () => {
    if (!pathRef.current) return;
    pendingRef.current = null;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    await clearProgress(pathRef.current);
    setInitialProgress(null);
    setResumeAt(null);
    setLive(null);
    // The blind spot was anchored to a record that no longer exists.
    startedAtRef.current = null;
  }, []);

  return {
    initialProgress,
    reportProgress,
    setManualProgress,
    clearProgress: clear,
    // Where the reader is right now, or null before they have moved. The caller overlays this
    // on the stored record so the readout tracks reading; the furthest mark still only ever
    // advances, and that stays the server's decision.
    live,
    // The "resumed at X" affordance: shown once per open, dismissible, never blocking.
    resumeAt: dismissed ? null : resumeAt,
    dismissResume: useCallback(() => setDismissed(true), []),
  };
}
