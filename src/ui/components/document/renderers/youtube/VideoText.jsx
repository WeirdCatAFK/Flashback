/**
 * VideoText — the text under the player, which is the document: the transcript read as
 * paragraphs when the video has captions, and your notes when it has none. Each
 * paragraph or note hangs its time in the gutter to its left (click it to play from
 * there), the one at the current time carries the accent, and highlights are `<mark
 * data-hl>` like in any other document, so the card margin, Find, the selection toolbar
 * and a click on a highlight all work on it unchanged. A paragraph's `<p data-para>`
 * holds nothing but its text, which is how a selection is read back as offsets.
 *
 * A note being written is a field inside its highlight: Enter keeps it, Esc leaves it
 * as the time it was marked at. Notes typed before captions were fetched, whose words
 * are not in the transcript, stay as notes between the paragraphs.
 */

import { useEffect, useRef } from 'react';
import { useT } from '../../../../translations/index';
import { segments, isBlankNote } from './transcript.js';
import { formatTime } from './time.js';

function NoteField({ note, onDone }) {
  const { t } = useT();
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const finish = (keep) => {
    if (done.current) return;
    done.current = true;
    onDone(keep ? ref.current.value : (isBlankNote(note.text) ? '' : note.text));
  };
  return (
    <input
      ref={ref}
      className="yt-note__input"
      defaultValue={isBlankNote(note.text) ? '' : note.text}
      placeholder={t('What’s at {time}?', { time: formatTime(note.start ?? 0) })}
      aria-label={t('Note for the moment at {time}', { time: formatTime(note.start ?? 0) })}
      autoComplete="off"
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function Note({ note, now, composing, onSeek, onEdit, onDone }) {
  const { t } = useT();
  const blank = isBlankNote(note.text);
  return (
    <div className={`yt-para yt-note${now ? ' is-now' : ''}${composing ? ' is-writing' : ''}`}>
      <button type="button" className="yt-time" onClick={() => onSeek(note.start ?? 0)} title={t('Play from {time}', { time: formatTime(note.start ?? 0) })}>{formatTime(note.start ?? 0)}</button>
      <div className="yt-note__body">
        <mark data-hl={note.id} data-color={note.color ?? 'amber'}>
          {composing ? <NoteField note={note} onDone={(text) => onDone(note.id, text)} />
            : blank ? <span className="yt-note__blank">{t('Moment at {time}', { time: formatTime(note.start ?? 0) })}</span>
              : note.text}
        </mark>
        {composing
          ? <span className="yt-note__hint">{t('Enter to keep · Esc to leave it as a time')}</span>
          : <button type="button" className="link-action yt-note__edit" onClick={() => onEdit(note.id)}>{blank ? t('Add a note') : t('Edit')}</button>}
      </div>
    </div>
  );
}

export default function VideoText({ rootRef, paras, placement, notes, nowKey, composing, transcript, fetching, fetchError, onSeek, onEdit, onNoteDone, onFetch }) {
  const { t } = useT();
  const hasTranscript = paras.length > 0;
  const auto = transcript?.kind === 'asr';

  const items = hasTranscript
    ? [...paras.map((p, i) => ({ kind: 'para', at: p.start, i })), ...placement.loose.map((n) => ({ kind: 'note', at: n.start ?? 0, note: n }))]
      .sort((a, b) => a.at - b.at)
    : [...notes].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)).map((n) => ({ kind: 'note', at: n.start ?? 0, note: n }));

  return (
    <div className="yt-text" ref={rootRef} data-column>
      <div className="yt-text__head">
        <span className="yt-text__label">{hasTranscript ? t('Transcript') : t('Your notes')}</span>
        {hasTranscript ? (
          <span className="yt-text__sub">{[transcript?.lang, auto ? t('auto-generated') : null].filter(Boolean).join(' · ')}</span>
        ) : (
          <>
            <span className="yt-text__sub">{t('No captions fetched')}</span>
            <button type="button" className="link-action yt-text__fetch" onClick={onFetch} disabled={fetching} title={t('Fetch the video’s captions so its transcript is readable and can be turned into cards')}>
              {fetching ? t('Fetching captions…') : t('Fetch captions')}
            </button>
          </>
        )}
      </div>
      {fetchError && !hasTranscript && <p className="yt-text__error" role="status">{fetchError}</p>}
      {items.length === 0 && (
        <p className="yt-text__empty">{t('No notes yet. Press M while it plays to mark a moment, and say what’s in it.')}</p>
      )}
      {items.map((it) => (it.kind === 'para' ? (
        <div key={`p${it.i}`} className={`yt-para${nowKey === `p${it.i}` ? ' is-now' : ''}`}>
          <button type="button" className="yt-time" onClick={() => onSeek(paras[it.i].start)} title={t('Play from {time}', { time: formatTime(paras[it.i].start) })}>{formatTime(paras[it.i].start)}</button>
          <p data-para={it.i}>
            {segments(paras[it.i].text, placement.ranges.get(it.i)).map((s, k) => (s.id
              ? <mark key={k} data-hl={s.id} data-color={s.color}>{s.text}</mark>
              : s.text))}
          </p>
        </div>
      ) : (
        <Note
          key={it.note.id}
          note={it.note}
          now={nowKey === it.note.id}
          composing={composing === it.note.id}
          onSeek={onSeek}
          onEdit={onEdit}
          onDone={onNoteDone}
        />
      )))}
    </div>
  );
}
