/**
 * ReadingBar — the strip under the tab bar: where you are in a document, the
 * furthest mark as a track across the full width, the resume prompt, the
 * set-here / finished / clear actions, Go to start, and Find.
 */

import { useState } from "react";
import { useT } from "../../translations/index";

/**
 * The reading strip, pinned under the tab bar for every format: where you are, how
 * you got there, the manual controls, and Find.
 *
 * It exists because automatic capture alone is not enough — a position recorded by
 * scrolling can be wrong (you skimmed ahead, you read the paper copy, you want to start
 * over), and without a way to say so the mark can only ever move forward. That is the
 * whole reason `manual` mode exists in the API, and this is its only entry point in the
 * app; without it, correcting a position would require an AI assistant.
 *
 * `tracks` is the renderer's `tracksProgress`, read from the registry because this renders
 * outside the Suspense boundary, before the renderer's chunk has arrived. A format that
 * records no position still gets the strip, with Find alone: finding cards and highlights
 * is for every document.
 *
 * It used to come in two variants, one of them dropped into the PDF, EPUB and YouTube
 * toolbars so two bars would not stack. The head now scrolls away above every format, so
 * the reading controls sit in one place for all of them, under the tabs.
 *
 * @param {object|null} progress - the caller's current record, or null if never opened.
 * @param {boolean} tracks - whether this format records a reading position.
 * @param {boolean} resumed - whether this open jumped to a saved position.
 * @param {() => void} onGoToStart
 * @param {() => void} onDismissResume
 * @param {(body: object) => Promise<void>} onSetHere - marks the live position.
 * @param {(body: object) => Promise<void>} onMarkFinished
 * @param {() => Promise<void>} onClear
 * @param {() => object|null} readPosition - the renderer's live position, via progressRef.
 * @param {() => void} onFind - opens or closes the finder.
 * @param {boolean} findOpen
 * @param {(el: HTMLElement|null) => void} [toolsRef] - receives the slot a renderer's own
 *   tools (PDF zoom, EPUB text size) are portaled into, so they share this one bar.
 */
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
