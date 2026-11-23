import { useState } from "react";
import { useT } from "../../translations/index";

export default function ReadingBar({
  progress,
  tracks = true,
  resumed,
  onGoToStart,
  onDismissResume,
  onSetHere,
  onMarkFinished,
  onClear,
  readPosition,
  onFind,
  findOpen = false,
  toolsRef,
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const asPct = (n) => (n != null ? Math.round(n * 100) : null);
  const markPct = progress?.finished ? 100 : asPct(progress?.furthestPercent);
  const pct = asPct(progress?.percent) ?? markPct;

  const where = (() => {
    if (!progress) return t("Not started");
    if (progress.finished) return t("Finished");
    const page = progress.position?.page;
    if (page != null && progress.total)
      return t("Page {n} of {total}", { n: page, total: progress.total });
    if (page != null) return t("Page {n}", { n: page });
    if (pct != null) return t("{percent}% read", { percent: pct });
    return t("In progress");
  })();

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const setHere = () =>
    run(async () => {
      const live = readPosition?.();
      if (live) await onSetHere(live);
    });

  const markFinished = () =>
    run(async () => {
      const live = readPosition?.();
      await onMarkFinished({
        ...(live ?? { unit: "chars", position: { offset: 0 } }),
        percent: 1,
      });
    });

  const find = (
    <button
      type="button"
      className="doc-reading-find"
      aria-expanded={findOpen}
      aria-controls="doc-finder"
      onClick={onFind}
    >
      {t("Find")} <kbd>{t("Ctrl F")}</kbd>
    </button>
  );

  const tools = <span className="doc-reading-tools" ref={toolsRef} />;

  if (!tracks) {
    return <div className="doc-reading-bar doc-reading-bar--bare">{tools}{find}</div>;
  }

  return (
    <>
      <div className="doc-reading-bar">
        <b className="doc-reading-where">{where}</b>
        {resumed && (
          <span className="doc-reading-resume">
            {t("Resumed where you left off")}
            <button type="button" className="doc-reading-dismiss" onClick={onDismissResume} aria-label={t("Dismiss")}>
              &times;
            </button>
          </span>
        )}
        <span className="doc-reading-group">
          <button type="button" className="doc-reading-action" onClick={setHere} disabled={busy}>
            {t("Set mark here")}
          </button>
          {!progress?.finished && (
            <button type="button" className="doc-reading-action" onClick={markFinished} disabled={busy}>
              {t("Mark finished")}
            </button>
          )}
          {progress && (
            <button type="button" className="doc-reading-action" onClick={() => run(onClear)} disabled={busy}>
              {t("Clear")}
            </button>
          )}
        </span>
        <button type="button" className="doc-reading-action" onClick={onGoToStart}>
          {t("Go to start")}
        </button>
        {tools}
        {find}
      </div>
      <div className="doc-reading-track" aria-hidden="true" title={markPct != null ? t("{percent}% read", { percent: markPct }) : undefined}>
        <i style={{ width: `${markPct ?? 0}%` }} />
      </div>
    </>
  );
}
