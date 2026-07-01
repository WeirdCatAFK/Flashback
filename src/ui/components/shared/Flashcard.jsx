import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './Flashcard.css';

// Presentation-only flashcard renderer. No evaluation/SRS/persistence logic.
// Fully controlled: the parent owns `face` and is notified via `onFlip`.
//
// Card types (card.cardType):
//   basic       — standard front/back flip
//   reversible  — same data, direction chosen by parent (card.direction)
//   cloze       — {{blank}} syntax; front shows blanks, back reveals them
//   type_answer — front shows question + inline input; parent hears onTypeCheck(answer)
//   custom      — card.customData.html rendered in a sandboxed iframe
//
// flyOut(kind) and check() are exposed via ref for parent-driven animation / answer submit.

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

// Renders inline-only (no <p>/<pre> wrappers) so it stays valid nested inside a <span> —
// used for cloze fragments, which must flow inline alongside the blank/answer spans.
const INLINE_MARKDOWN_COMPONENTS = { p: 'span' };

// Anki's default MathJax config (and its older tex plugin) mark math with
// \(...\)/\[...\] or [$]...[/$]/[$$]...[/$$] rather than the $/$$ that
// remark-math looks for.
const MATH_DELIMITER = /\\\(|\\\[|\[\$\]|\[\$\$\]/;

function normalizeMathDelimiters(text) {
  return text
    .replace(/\[\$\$\]([\s\S]+?)\[\/\$\$\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\[\$\]([\s\S]+?)\[\/\$\]/g, (_, expr) => `$${expr}$`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => `$${expr}$`);
}

// remark-math treats any $...$ pair as math, so it's only enabled for cards that
// actually use one of Anki's math delimiters — otherwise a stray "$5 and $10"
// in unrelated card text would get misread as an equation.
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

function CardFace({ side, text, img, sound, resolve, audioRef, badge }) {
  const imgSrc = img ? resolve(img) : null;
  const soundSrc = sound ? resolve(sound) : null;

  const replay = (e) => {
    e.stopPropagation();
    const a = audioRef?.current;
    if (a) { try { a.currentTime = 0; } catch { } a.play().catch(() => {}); }
  };

  return (
    <div className={`flashcard-face flashcard-face--${side}`}>
      {badge}
      {imgSrc && (
        <div className="flashcard-media">
          <img src={imgSrc} alt="" draggable={false} />
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
            aria-label="Replay audio"
            title="Replay audio"
          >
            <AudioIcon />
          </button>
        </>
      )}
    </div>
  );
}

function ClozeFace({ side, parts }) {
  return (
    <div className={`flashcard-face flashcard-face--${side}`}>
      <div className="flashcard-text flashcard-cloze">
        {parts.map((p, i) =>
          p.type === 'blank'
            ? <span key={`blank-${i}`} className={side === 'front' ? 'cloze-blank' : 'cloze-answer'}>
                {side === 'front' ? '      ' : p.content}
              </span>
            : <span key={`text-${i}`}><CardMarkdown inline>{p.content}</CardMarkdown></span>
        )}
      </div>
    </div>
  );
}

const Flashcard = forwardRef(function Flashcard({
  card,
  face = 'front',
  onFlip,
  onSwipe,
  onTypeCheck,           // (typedAnswer: string) => void — type_answer only
  variant = 'full',      // 'full' (flip canvas) | 'static' (no flip, single face)
  resolveMedia,
  className = '',
}, ref) {
  const rootRef = useRef(null);
  const frontAudioRef = useRef(null);
  const backAudioRef = useRef(null);
  const inputRef = useRef(null);
  const isStatic = variant === 'static';

  // Backward compat: isCustom flag from old sidecar format
  const cardType = card?.cardType ?? (card?.isCustom ? 'custom' : 'basic');

  // Typed answer state for type_answer cards; exposed via check() on the ref.
  const [typed, setTyped] = useState('');

  // Swipe / drag state
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
    let frames, duration;
    if (kind === 'accept') {
      const tilt = start >= 0 ? 8 : -8;
      frames = [
        { transform: `translate(${start}px, 0) scale(1) rotate(${start * 0.04}deg)`, opacity: 1 },
        { transform: `translate(${start * 0.6}px, -44px) scale(1.06) rotate(${start * 0.02}deg)`, opacity: 1, offset: 0.32 },
        { transform: `translate(${start * 0.4}px, -480px) scale(0.7) rotate(${tilt}deg)`, opacity: 0 },
      ];
      duration = 460;
    } else {
      frames = [
        { transform: `translate(${start}px, 0) rotate(${start * 0.05}deg)`, opacity: 1 },
        { transform: `translate(${start * 0.4 - 16}px, 2px) rotate(-4deg)`, opacity: 1, offset: 0.18 },
        { transform: 'translate(16px, 4px) rotate(4deg)', opacity: 1, offset: 0.40 },
        { transform: 'translate(-8px, 6px) rotate(-2deg)', opacity: 1, offset: 0.60 },
        { transform: 'translate(0px, 26px) scale(0.9) rotate(0deg)', opacity: 0.12 },
      ];
      duration = 520;
    }
    const anim = el.animate(frames, { duration, easing: 'cubic-bezier(.45, 0, .55, 1)', fill: 'forwards' });
    const done = () => resolve(true);
    anim.onfinish = done;
    anim.oncancel = done;
  }), [drag]);

  const runFlyOutRef = useRef(runFlyOut);
  runFlyOutRef.current = runFlyOut;
  const flyOut = useCallback((kind) => runFlyOutRef.current(kind), []);

  // check() lets the Trainer submit the typed answer via the reveal keybinding.
  const doCheck = useCallback(() => {
    if (typed.trim()) {
      onTypeCheck?.(typed);
      inputRef.current?.blur();
    }
  }, [typed, onTypeCheck]);

  useImperativeHandle(ref, () => ({ flyOut, check: doCheck }), [flyOut, doCheck]);

  // Auto-play the audio of the active face; pause/reset the other.
  useEffect(() => {
    if (isStatic || cardType === 'custom') return;
    const active = face === 'back' ? backAudioRef.current : frontAudioRef.current;
    const other  = face === 'back' ? frontAudioRef.current : backAudioRef.current;
    if (other)  { other.pause(); try { other.currentTime = 0; } catch { } }
    if (active) { try { active.currentTime = 0; } catch { } active.play().catch(() => {}); }
  }, [face, isStatic, cardType]);

  // Auto-focus the answer input when a type_answer card appears on the front face.
  useEffect(() => {
    if (cardType === 'type_answer' && face === 'front' && !isStatic) {
      inputRef.current?.focus();
    }
  }, [cardType, face, isStatic]);

  // Custom card: sandboxed iframe renderer.
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
                  title="Custom flashcard"
                />
              </div>
            : <div className="flashcard-face flashcard-custom-slot">
                <span className="flashcard-custom-badge">Custom</span>
                <p className="flashcard-custom-note">No HTML content yet. Edit this card to add it.</p>
              </div>
          }
        </div>
      </div>
    );
  }

  const resolve = resolveMedia ?? ((r) => r);
  const v = card?.vanillaData ?? {};
  const media = v.media ?? {};

  // Reversible: swap front/back content based on card.direction.
  const direction = card?.direction ?? 'forward';
  const isReversed = cardType === 'reversible' && direction === 'reverse';

  const frontText  = isReversed ? v.backText  : v.frontText;
  const backText   = isReversed ? v.frontText : v.backText;
  const frontImg   = isReversed ? media.back_img    : media.front_img;
  const backImg    = isReversed ? media.front_img   : media.back_img;
  const frontSound = isReversed ? media.back_sound  : media.front_sound;
  const backSound  = isReversed ? media.front_sound : media.back_sound;

  const dirBadge = cardType === 'reversible'
    ? <span className="flashcard-direction-badge">{direction === 'reverse' ? '← Reverse' : 'Forward →'}</span>
    : null;

  // Build type-specific face elements.
  let frontFace, backFace;

  if (cardType === 'cloze') {
    const clozeParts = parseCloze(frontText ?? '');
    frontFace = <ClozeFace side="front" parts={clozeParts} />;
    backFace  = <ClozeFace side="back"  parts={clozeParts} />;
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
    frontFace = (
      <div className="flashcard-face flashcard-face--front">
        {frontImgSrc && <div className="flashcard-media"><img src={frontImgSrc} alt="" draggable={false} /></div>}
        {frontText && <div className="flashcard-text"><CardMarkdown>{frontText}</CardMarkdown></div>}
        {frontSndSrc && (
          <>
            <audio ref={frontAudioRef} src={frontSndSrc} preload="auto" aria-hidden="true" />
            <button type="button" className="flashcard-audio-btn" onClick={replayFront}
              onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
              aria-label="Replay audio" title="Replay audio"><AudioIcon /></button>
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
              placeholder="Type your answer…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Answer input"
              rows={4}
            />
            <button
              type="button"
              className="type-answer-check"
              onClick={(e) => { e.stopPropagation(); doCheck(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={!typed.trim()}
            >
              Check
            </button>
          </div>
        )}
      </div>
    );
    backFace = (
      <div className="flashcard-face flashcard-face--back">
        {backImgSrc && <div className="flashcard-media"><img src={backImgSrc} alt="" draggable={false} /></div>}
        {backText && <div className="flashcard-text"><CardMarkdown>{backText}</CardMarkdown></div>}
        {backSndSrc && (
          <>
            <audio ref={backAudioRef} src={backSndSrc} preload="auto" aria-hidden="true" />
            <button type="button" className="flashcard-audio-btn" onClick={replayBack}
              onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
              aria-label="Replay audio" title="Replay audio"><AudioIcon /></button>
          </>
        )}
      </div>
    );
  } else {
    // basic or reversible
    frontFace = (
      <CardFace side="front" text={frontText} img={frontImg} sound={frontSound}
        resolve={resolve} audioRef={frontAudioRef} badge={dirBadge} />
    );
    backFace = (
      <CardFace side="back" text={backText} img={backImg} sound={backSound}
        resolve={resolve} audioRef={backAudioRef} />
    );
  }

  if (isStatic) {
    return (
      <div className={`flashcard flashcard--static ${className}`}>
        <div className="flashcard-inner">{face === 'back' ? backFace : frontFace}</div>
      </div>
    );
  }

  // For type_answer front: clicking the card body should not flip — the Check
  // button is the only reveal mechanism.
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
      aria-label={`Flashcard showing ${face} side.${!noFlipOnClick ? ' Activate to flip.' : ''}`}
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
