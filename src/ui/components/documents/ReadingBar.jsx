import { useState } from 'react';
import { useT } from '../../translations';

/**
 * The reading strip above a readable document: where you are, how you got there, and the
 * manual controls.
 *
 * It exists because automatic capture alone is not enough — a position recorded by
 * scrolling can be wrong (you skimmed ahead, you read the paper copy, you want to start
 * over), and without a way to say so the mark can only ever move forward. That is the
 * whole reason `manual` mode exists in the API, and this is its only entry point in the
 * app; without it, correcting a position would require an AI assistant.
 *
 * Shown only for renderers whose registry entry sets `tracksProgress`, which is why that
 * flag is data in the registry rather than a static on a lazily-loaded component: this
 * renders outside the Suspense boundary, before the renderer's chunk has arrived.
 *
 * Two variants, because half the renderers already own a toolbar. `strip` is the standalone
 * row above the document, for the formats that have no chrome of their own (Markdown, text,
 * clips). `inline` is the same controls with the surface taken away, handed to a renderer
 * that sets `ownsReadingBar` and dropped into its toolbar — one bar instead of two stacked
 * ones. The element is still built here and imported statically, so it stays outside the
 * lazy chunk; only where it mounts changes.
 *
 * `inline` shortens the position rather than dropping it: a toolbar is a row of small
 * facts, and "Page 12 of 40" beside a "40 pages" count repeats the total for no one. It
 * becomes "p. 12", the track carries the shape, and the states that are not positions at
 * all — `Not started`, `Finished` — read the same in both variants.
 *
 * @param {object|null} progress - the caller's current record, or null if never opened.
 * @param {boolean} resumed - whether this open jumped to a saved position.
 * @param {() => void} onGoToStart
 * @param {() => void} onDismissResume
 * @param {(body: object) => Promise<void>} onSetHere - marks the live position.
 * @param {(body: object) => Promise<void>} onMarkFinished
 * @param {() => Promise<void>} onClear
 * @param {() => object|null} readPosition - the renderer's live position, via progressRef.
 * @param {'strip'|'inline'} [variant] - standalone row, or hosted in a renderer's toolbar.
 */
export default function ReadingBar({
  progress,
  resumed,
  onGoToStart,
  onDismissResume,
  onSetHere,
  onMarkFinished,
  onClear,
  readPosition,
  variant = 'strip',
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const pct = progress?.furthestPercent != null
    ? Math.round(progress.furthestPercent * 100)
    : null;

  const inline = variant === 'inline';

  // Only a page number means anything to a reader; a CFI or a character offset does not,
  // so everything else falls back to the percentage.
  const where = (() => {
    if (!progress) return t('Not started');
    if (progress.finished) return t('Finished');
    const page = progress.position?.page;
    if (inline) {
      // The host toolbar already states the document's size, so the total is dropped and
      // only the mark itself is named.
      if (page != null) return t('p. {n}', { n: page });
      return pct != null ? t('{percent}%', { percent: pct }) : t('In progress');
    }
    if (page != null && progress.total) return t('Page {n} of {total}', { n: page, total: progress.total });
    if (page != null) return t('Page {n}', { n: page });
    if (pct != null) return t('{percent}% read', { percent: pct });
    return t('In progress');
  })();

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch { /* a failed mark is not worth interrupting reading over */ }
    finally { setBusy(false); }
  };

  const setHere = () => run(async () => {
    const live = readPosition?.();
    if (live) await onSetHere(live);
  });

  const markFinished = () => run(async () => {
    const live = readPosition?.();
    await onMarkFinished({ ...(live ?? { unit: 'chars', position: { offset: 0 } }), percent: 1 });
  });

  return (
    <div className={`doc-reading-bar${inline ? ' doc-reading-bar--inline' : ''}`}>
      {resumed ? (
        <>
          {/* A toolbar has no room for the sentence, but the way back must still be one
              click away, so inline keeps the action and drops the prose around it. */}
          <span className="doc-reading-where">
            {inline ? t('Resumed') : t('Resumed where you left off')}
          </span>
          <button type="button" className="doc-reading-action" onClick={onGoToStart}>
            {t('Go to start')}
          </button>
          <button
            type="button"
            className="doc-reading-dismiss"
            onClick={onDismissResume}
            aria-label={t('Dismiss')}
          >
            &times;
          </button>
        </>
      ) : (
        <>
          <span className="doc-reading-where">{where}</span>
          {pct != null && (
            <span
              className="doc-reading-bar-track"
              title={t('{percent}% read', { percent: pct })}
              aria-hidden="true"
            >
              <span style={{ width: `${pct}%` }} />
            </span>
          )}
          <button type="button" className="doc-reading-action" onClick={setHere} disabled={busy}>
            {t('Set mark here')}
          </button>
          {!progress?.finished && (
            <button type="button" className="doc-reading-action" onClick={markFinished} disabled={busy}>
              {t('Mark finished')}
            </button>
          )}
          {progress && (
            <button
              type="button"
              className="doc-reading-action doc-reading-action--quiet"
              onClick={() => run(onClear)}
              disabled={busy}
            >
              {t('Clear')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
