/**
 * One document's read progress: the stored record, a debounced report of the
 * live position, the resume prompt, and the manual set-here / finished / clear
 * writes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getProgress, setProgress, clearProgress } from "../../api/progress";

/**
 * How long a document must be open before it can acquire a reading position.
 *
 * Without this, single-clicking through a folder in preview tabs would stamp a position
 * onto every file touched — which is worst in exactly the case this feature exists for, a
 * freshly imported folder of hundreds of documents. A glance is not reading.
 */
const MIN_DWELL_MS = 5000;

/**
 * Capture is continuous; writing is not. The renderer reports on every scroll, and this is
 * how long the reports settle before one request goes out. Also flushed on unmount, on a
 * path change, and when the tab is hidden, so closing a document never loses the last move.
 */
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
  const [initialProgress, setInitialProgress] = useState(undefined);
  const [resumeAt, setResumeAt] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [live, setLive] = useState(null);

  const pendingRef = useRef(null);
  const timerRef = useRef(null);
  const openedAtRef = useRef(0);
  const startedAtRef = useRef(null);
  const pathRef = useRef(path);

  const flushRef = useRef(() => {});
  flushRef.current = async () => {
    const job = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!job) return;
    try {
      await setProgress(job.path, job.body);
    } catch {}
  };

  useEffect(() => {
    pathRef.current = path;
    setInitialProgress(undefined);
    setResumeAt(null);
    setDismissed(false);
    setLive(null);
    startedAtRef.current = null;
    openedAtRef.current = Date.now();
    if (!path) {
      setInitialProgress(null);
      return;
    }

    let live = true;
    getProgress(path)
      .then((p) => {
        if (!live) return;
        setInitialProgress(p ?? null);
        startedAtRef.current = p?.position ?? null;
        if (p?.position) setResumeAt(p);
      })
      .catch(() => {
        if (live) setInitialProgress(null);
      });

    return () => {
      live = false;
    };
  }, [path]);

  useEffect(
    () => () => {
      flushRef.current();
    },
    [path],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const reportProgress = useCallback(
    (reportPath, { unit, position, percent, total }) => {
      if (!reportPath || !unit || !position) return;
      if (reportPath !== pathRef.current) return;
      if (Date.now() - openedAtRef.current < MIN_DWELL_MS) return;
      if (samePlace(position, startedAtRef.current)) return;

      startedAtRef.current = null;

      setLive({
        unit,
        position,
        percent: percent ?? null,
        total: total ?? null,
      });

      pendingRef.current = {
        path: reportPath,
        body: { unit, position, percent, total, mode: "auto" },
      };
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          flushRef.current();
        }, FLUSH_MS);
      }
    },
    [],
  );

  const setManualProgress = useCallback(async (body) => {
    if (!pathRef.current) return null;
    await flushRef.current();
    const res = await setProgress(pathRef.current, { ...body, mode: "manual" });
    return res?.progress ?? null;
  }, []);

  const clear = useCallback(async () => {
    if (!pathRef.current) return;
    pendingRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await clearProgress(pathRef.current);
    setInitialProgress(null);
    setResumeAt(null);
    setLive(null);
    startedAtRef.current = null;
  }, []);

  return {
    initialProgress,
    reportProgress,
    setManualProgress,
    clearProgress: clear,
    live,
    resumeAt: dismissed ? null : resumeAt,
    dismissResume: useCallback(() => setDismissed(true), []),
  };
}
