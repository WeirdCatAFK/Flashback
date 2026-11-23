import { useCallback, useEffect, useRef, useState } from "react";
import { getProgress, setProgress, clearProgress } from "../../api/progress";

const MIN_DWELL_MS = 5000;

const FLUSH_MS = 3000;

function samePlace(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

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
