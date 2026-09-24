/**
 * Flashcard — the card itself: front and back faces with media, the flip, the
 * swipe grade, the typed-answer check, and the fly-out animation the Trainer
 * drives through its ref. `source`, when given, is cited at the foot of the answer
 * side — never the question side, where it could give the answer away. `verdict`
 * (`{ typed, correct }`) is what a type_answer card says on its answer side about
 * what was typed; comparing is the caller's business, not the card's.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { typeAnswerParts } from './flashcardFields';
import { useT } from '../../translations/index';
import './Flashcard.css';

const SWIPE_THRESHOLD = 90;

function parseCloze(text = '') {
  const parts = [];
  const regex = /\{\{([^}]+)\}\}/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
    parts.push({ type: 'blank', content: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });
  return parts;
}

/**
 * Renders inline-only (no <p>/<pre> wrappers) so it stays valid nested inside a <span> —
 * used for cloze fragments, which must flow inline alongside the blank/answer spans.
 */
const INLINE_MARKDOWN_COMPONENTS = { p: 'span' };

/**
 * Anki's default MathJax config (and its older tex plugin) mark math with
 * \(...\)/\[...\] or [$]...[/$]/[$$]...[/$$] rather than the $/$$ that
 * remark-math looks for.
 */
const MATH_DELIMITER = /\\\(|\\\[|\[\$\]|\[\$\$\]/;

function normalizeMathDelimiters(text) {
  return text
    .replace(/\[\$\$\]([\s\S]+?)\[\/\$\$\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\[\$\]([\s\S]+?)\[\/\$\]/g, (_, expr) => `$${expr}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`);
}

/**
 * remark-math treats any $...$ pair as math, so it's only enabled for cards that
 * actually use one of Anki's math delimiters — otherwise a stray "$5 and $10"
 * in unrelated card text would get misread as an equation.
 */
function CardMarkdown({ children, inline = false }) {
  if (!children) return null;
  const hasMath = MATH_DELIMITER.test(children);
  return (
    <ReactMarkdown
      remarkPlugins={hasMath ? [remarkBreaks, remarkMath] : [remarkBreaks]}
      rehypePlugins={hasMath ? [rehypeKatex] : undefined}
      components={inline ? INLINE_MARKDOWN_COMPONENTS : undefined}
    >
      {hasMath ? normalizeMathDelimiters(children) : children}
    </ReactMarkdown>
  );
}

function AudioIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19.5 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

/** The citation at the foot of an answer face. */
function SourceLine({ source }) {
  if (!source) return null;
  return <div className="flashcard-source" title={source}>{source}</div>;
}

function CardFace({ side, text, img, sound, resolve, audioRef, badge, source }) {
  const { t } = useT();
  const imgSrc = img ? resolve(img) : null;
  const soundSrc = sound ? resolve(sound) : null;

  const replay = (e) => {
    e.stopPropagation();
    const a = audioRef?.current;
    if (a) { try { a.currentTime = 0; } catch { } a.play().catch(() => {}); }
  };

  return (
    <div className={`flashcard-face flashcard-face--${side}${source ? ' flashcard-face--cited' : ''}`}>
      {badge}
      <SourceLine source={source} />
      {imgSrc && (
        <div className="flashcard-media">
          <img src={imgSrc} alt={side === 'front' ? t('Front side image') : t('Back side image')} draggable={false} />
        </div>
      )}
      {text && <div className="flashcard-text"><CardMarkdown>{text}</CardMarkdown></div>}
      {soundSrc && (
        <>
          <audio ref={audioRef} src={soundSrc} preload="auto" aria-hidden="true" />
          <button
            type="button"
            className="flashcard-audio-btn"
            onClick={replay}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={t('Replay audio')}
            title={t('Replay audio')}
          >
            <AudioIcon />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Cloze faces carry media like any other face. They used to render text only, which
 * silently discarded the front_img/front_sound the Anki importer has always written
 * for cloze notes — an audio-prompted cloze is an ordinary language-deck card.
 */
function ClozeFace({ side, parts, img, sound, resolve = (r) => r, audioRef, source }) {
  const { t } = useT();
  const imgSrc = img ? resolve(img) : null;
  const soundSrc = sound ? resolve(sound) : null;

  const replay = (e) => {
    e.stopPropagation();
    const a = audioRef?.current;
    if (a) { try { a.currentTime = 0; } catch { } a.play().catch(() => {}); }
  };

  return (
    <div className={`flashcard-face flashcard-face--${side}${source ? ' flashcard-face--cited' : ''}`}>
      <SourceLine source={source} />
      {imgSrc && (
        <div className="flashcard-media">
          <img src={imgSrc} alt={side === 'front' ? t('Front side image') : t('Back side image')} draggable={false} />
        </div>
      )}
      <div className="flashcard-text flashcard-cloze">
        {parts.map((p, i) =>
          p.type === 'blank'
            ? <span key={`blank-${i}`} className={side === 'front' ? 'cloze-blank' : 'cloze-answer'}>
                {side === 'front' ? '      ' : p.content}
              </span>
            : <span key={`text-${i}`}><CardMarkdown inline>{p.content}</CardMarkdown></span>
        )}
      </div>
      {soundSrc && (
        <>
          <audio ref={audioRef} src={soundSrc} preload="auto" aria-hidden="true" />
          <button
            type="button"
            className="flashcard-audio-btn"
            onClick={replay}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={t('Replay audio')}
            title={t('Replay audio')}
          >
            <AudioIcon />
          </button>
        </>
      )}
    </div>
  );
}

const Flashcard = forwardRef(function Flashcard({
  card,
  face = 'front',
  onFlip,
  onSwipe,
  onTypeCheck,
  variant = 'full',
  resolveMedia,
  autoplayAudio,
  source = null,
  verdict = null,
  className = '',
}, ref) {
  const { t } = useT();
  const rootRef = useRef(null);
  const frontAudioRef = useRef(null);
  const backAudioRef = useRef(null);
  const inputRef = useRef(null);
  const isStatic = variant === 'static';

  const cardType = card?.cardType ?? (card?.isCustom ? 'custom' : 'basic');

  const [typed, setTyped] = useState('');

  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const committedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const startXRef = useRef(0);

  const runFlyOut = useCallback((kind) => new Promise((resolve) => {
    if (committedRef.current) { resolve(false); return; }
    committedRef.current = true;
    const el = rootRef.current;
    if (!el) { resolve(true); return; }
    const start = drag;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let frames, duration, easing;
    if (kind === 'accept') {
      frames = [
        { transform: `translate(${start}px, 0) rotate(${start * 0.04}deg)`, opacity: 1 },
        { transform: `translate(${start - 6}px, 10px) scale(1.03) rotate(${start * 0.02 - 1}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${start + 48}px, -64px) scale(0.92) rotate(5deg)`, opacity: 0 },
      ];
      duration = 420;
      easing = 'cubic-bezier(.3, 0, .6, 1)';
    } else {
      frames = [
        { transform: `translate(${start}px, 0) rotate(${start * 0.04}deg)`, opacity: 1 },
        { transform: `translate(${start - 50}px, 40px) scale(0.92) rotate(-5deg)`, opacity: 0 },
      ];
      duration = 280;
      easing = 'cubic-bezier(.5, 0, .8, .4)';
    }
    const anim = el.animate(frames, { duration: reduce ? 1 : duration, easing, fill: 'forwards' });
    const done = () => resolve(true);
    anim.onfinish = done;
    anim.oncancel = done;
  }), [drag]);

  const runFlyOutRef = useRef(runFlyOut);
  runFlyOutRef.current = runFlyOut;
  const flyOut = useCallback((kind) => runFlyOutRef.current(kind), []);

  const doCheck = useCallback(() => {
    if (typed.trim()) {
      onTypeCheck?.(typed);
      inputRef.current?.blur();
    }
  }, [typed, onTypeCheck]);

  useImperativeHandle(ref, () => ({ flyOut, check: doCheck }), [flyOut, doCheck]);

  useEffect(() => {
    if (!(autoplayAudio ?? !isStatic) || cardType === 'custom') return;
    const active = face === 'back' ? backAudioRef.current : frontAudioRef.current;
    const other  = face === 'back' ? frontAudioRef.current : backAudioRef.current;
    if (other)  { other.pause(); try { other.currentTime = 0; } catch { } }
    if (active) { try { active.currentTime = 0; } catch { } active.play().catch(() => {}); }
  }, [face, isStatic, cardType, autoplayAudio]);

  useEffect(() => {
    if (cardType === 'type_answer' && face === 'front' && !isStatic) {
      inputRef.current?.focus();
    }
  }, [cardType, face, isStatic]);

  if (cardType === 'custom') {
    const html = card?.customData?.html ?? '';
    return (
      <div className={`flashcard flashcard--static flashcard--custom ${className}`}>
        <div className="flashcard-inner">
          {html
            ? <div className="flashcard-face flashcard-custom-live">
                <iframe
                  className="flashcard-custom-iframe"
                  srcDoc={html}
                  sandbox="allow-scripts"
                  title={t('Custom flashcard')}
                />
              </div>
            : <div className="flashcard-face flashcard-custom-slot">
                <span className="flashcard-custom-badge">{t('Custom')}</span>
                <p className="flashcard-custom-note">{t('No HTML content yet. Edit this card to add it.')}</p>
              </div>
          }
        </div>
      </div>
    );
  }

  const resolve = resolveMedia ?? ((r) => r);
  const v = card?.vanillaData ?? {};
  const media = v.media ?? {};

  const direction = card?.direction ?? 'forward';
  const isReversed = cardType === 'reversible' && direction === 'reverse';

  const frontText  = isReversed ? v.backText  : v.frontText;
  const backText   = isReversed ? v.frontText : v.backText;
  const frontImg   = isReversed ? media.back_img    : media.front_img;
  const backImg    = isReversed ? media.front_img   : media.back_img;
  const frontSound = isReversed ? media.back_sound  : media.front_sound;
  const backSound  = isReversed ? media.front_sound : media.back_sound;

  const dirBadge = cardType === 'reversible'
    ? <span className="flashcard-direction-badge">{direction === 'reverse' ? t('← Reverse') : t('Forward →')}</span>
    : null;

  let frontFace, backFace;

  if (cardType === 'cloze') {
    const clozeParts = parseCloze(frontText ?? '');
    frontFace = <ClozeFace side="front" parts={clozeParts}
      img={frontImg} sound={frontSound} resolve={resolve} audioRef={frontAudioRef} />;
    backFace  = <ClozeFace side="back"  parts={clozeParts}
      img={backImg} sound={backSound} resolve={resolve} audioRef={backAudioRef} source={source} />;
  } else if (cardType === 'type_answer') {
    const frontImgSrc  = frontImg   ? resolve(frontImg)   : null;
    const frontSndSrc  = frontSound ? resolve(frontSound) : null;
    const backImgSrc   = backImg    ? resolve(backImg)    : null;
    const backSndSrc   = backSound  ? resolve(backSound)  : null;
    const replayFront  = (e) => {
      e.stopPropagation();
      const a = frontAudioRef?.current;
      if (a) { try { a.currentTime = 0; } catch { } a.play().catch(() => {}); }
    };
    const replayBack = (e) => {
      e.stopPropagation();
      const a = backAudioRef?.current;
      if (a) { try { a.currentTime = 0; } catch { } a.play().catch(() => {}); }
    };
    const { answer: expectedAnswer, notes: answerNotes } = typeAnswerParts(v);

    frontFace = (
      <div className="flashcard-face flashcard-face--front">
        {frontImgSrc && <div className="flashcard-media"><img src={frontImgSrc} alt={t('Front side image')} draggable={false} /></div>}
        {frontText && <div className="flashcard-text"><CardMarkdown>{frontText}</CardMarkdown></div>}
        {frontSndSrc && (
          <>
            <audio ref={frontAudioRef} src={frontSndSrc} preload="auto" aria-hidden="true" />
            <button type="button" className="flashcard-audio-btn" onClick={replayFront}
              onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
              aria-label={t('Replay audio')} title={t('Replay audio')}><AudioIcon /></button>
          </>
        )}
        {!isStatic && (
          <div className="type-answer-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <textarea
              ref={inputRef}
              className="type-answer-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doCheck(); }
              }}
              placeholder={t('Your answer')}
              autoComplete="off"
              spellCheck={false}
              aria-label={t('Answer input')}
              rows={4}
            />
            <button
              type="button"
              className="type-answer-check"
              onClick={(e) => { e.stopPropagation(); doCheck(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!typed.trim()}
            >
              {t('Check')}
            </button>
          </div>
        )}
      </div>
    );
    backFace = (
      <div className={`flashcard-face flashcard-face--back${source ? ' flashcard-face--cited' : ''}`}>
        <SourceLine source={source} />
        {backImgSrc && <div className="flashcard-media"><img src={backImgSrc} alt={t('Back side image')} draggable={false} /></div>}
        {expectedAnswer && <div className="flashcard-text"><CardMarkdown>{expectedAnswer}</CardMarkdown></div>}
        {verdict && (
          <div className="flashcard-you-wrote">
            {t('You wrote')}{' '}
            <span className={verdict.correct ? 'flashcard-you-wrote--ok' : 'flashcard-you-wrote--no'}>{verdict.typed?.trim() || '—'}</span>
          </div>
        )}
        {answerNotes && (
          <div className="flashcard-notes"><CardMarkdown>{answerNotes}</CardMarkdown></div>
        )}
        {backSndSrc && (
          <>
            <audio ref={backAudioRef} src={backSndSrc} preload="auto" aria-hidden="true" />
            <button type="button" className="flashcard-audio-btn" onClick={replayBack}
              onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
              aria-label={t('Replay audio')} title={t('Replay audio')}><AudioIcon /></button>
          </>
        )}
      </div>
    );
  } else {
    frontFace = (
      <CardFace side="front" text={frontText} img={frontImg} sound={frontSound}
        resolve={resolve} audioRef={frontAudioRef} badge={dirBadge} />
    );
    backFace = (
      <CardFace side="back" text={backText} img={backImg} sound={backSound}
        resolve={resolve} audioRef={backAudioRef} source={source} />
    );
  }

  if (isStatic) {
    return (
      <div className={`flashcard flashcard--static ${className}`}>
        <div className="flashcard-inner">{face === 'back' ? backFace : frontFace}</div>
      </div>
    );
  }

  const noFlipOnClick = cardType === 'type_answer' && face === 'front';
  const swipeEnabled  = !!onSwipe && face === 'back';

  const flip = () => { if (!noFlipOnClick) onFlip?.(face === 'front' ? 'back' : 'front'); };

  const onClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    flip();
  };

  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if ((e.key === 'Enter' || e.key === ' ') && !noFlipOnClick) {
      e.preventDefault();
      flip();
    }
  };

  const onPointerDown = (e) => {
    if (!swipeEnabled || committedRef.current) return;
    startXRef.current = e.clientX;
    movedRef.current = false;
    draggingRef.current = true;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) > 6) movedRef.current = true;
    setDrag(dx);
  };

  const onPointerEnd = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (movedRef.current) suppressClickRef.current = true;
    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) >= SWIPE_THRESHOLD) {
      const dir = dx > 0 ? 'right' : 'left';
      runFlyOut(dir === 'right' ? 'accept' : 'reject').then((ok) => { if (ok) onSwipe(dir); });
    } else {
      setDrag(0);
    }
  };

  const dragStyle = swipeEnabled
    ? {
        transform: `translateX(${drag}px) rotate(${drag * 0.04}deg)`,
        transition: dragging ? 'none' : 'transform 240ms ease',
        cursor: dragging ? 'grabbing' : 'grab',
      }
    : undefined;

  return (
    <div
      ref={rootRef}
      className={`flashcard ${className}`}
      data-face={face}
      role="button"
      tabIndex={0}
      aria-label={
        (face === 'back' ? t('Flashcard showing back side.') : t('Flashcard showing front side.'))
        + (noFlipOnClick ? '' : ` ${t('Activate to flip.')}`)
      }
      style={dragStyle}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div className="flashcard-inner">
        {frontFace}
        {backFace}
      </div>
    </div>
  );
});

export default Flashcard;
