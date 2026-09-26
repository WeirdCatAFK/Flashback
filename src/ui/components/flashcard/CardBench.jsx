/**
 * CardBench — the card editor as a floating panel over the screen it was opened
 * from: a head naming the card and where it lives, then FlashcardForm. It rises in
 * when mounted and sinks out before `onClose` runs — on Cancel, Esc, or once
 * `onSubmit` / `onDelete` resolve truthy (a falsy result keeps it open, so a failed
 * save leaves the draft where it was). Every other prop goes to FlashcardForm.
 *
 *   {bench && <CardBench title={t('Edit card')} source={t('from {doc}', { doc })}
 *     initial={…} onSubmit={save} onDelete={remove} onClose={() => setBench(null)} />}
 */

import { useEffect, useId, useRef, useState } from 'react';
import FlashcardForm from './FlashcardForm';
import { useT } from '../../translations/index';
import './CardBench.css';

export default function CardBench({ title, source, onClose, onSubmit, onDelete = null, ...formProps }) {
  const { t } = useT();
  const titleId = useId();
  const ref = useRef(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    ref.current?.querySelector('textarea, input')?.focus({ preventScroll: true });
  }, []);

  const leave = () => setLeaving(true);
  const submit = async (payload) => { if (await onSubmit(payload)) leave(); };
  const remove = onDelete ? async () => { if (await onDelete()) leave(); } : null;

  return (
    <div
      ref={ref}
      className={`card-bench${leaving ? ' card-bench--leaving' : ''}`}
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); leave(); } }}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onClose(); }}
    >
      <div className="card-bench__head">
        <span className="card-bench__title" id={titleId}>{title}</span>
        {source && <span className="card-bench__source" title={source}>{source}</span>}
        <button type="button" className="card-bench__close" onClick={leave} aria-label={t('Close the editor')}>
          {t('Esc')}
        </button>
      </div>
      <div className="card-bench__body">
        <FlashcardForm {...formProps} onSubmit={submit} onCancel={leave} onDelete={remove} />
      </div>
    </div>
  );
}
