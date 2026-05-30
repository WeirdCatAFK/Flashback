import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import './Flashcard.css';

// Presentation-only flashcard renderer. No evaluation/SRS/persistence logic —
// that lives in whatever consumes it (Trainer, the creator preview, …).
//
// Fully controlled: the parent owns `face` and is notified via `onFlip`.
// Vanilla cards render on a strict 4:3 (landscape) / 3:4 (portrait) canvas for
// cross-device consistency; the orientation is a renderer decision passed in
// from the frontend config. Custom (HTML-engine) cards are routed to a stub
// slot — the seam for a future renderer, not in scope yet.
//
// Audio behaviour (full variant): the active face's sound plays automatically
// whenever that face is presented — on first show and on every flip — and a
// styled replay button stays available. The hidden-away face is paused/reset so
// the two sides never overlap.
//
// Swipe (opt-in via `onSwipe`, only once the answer is revealed — face 'back'):
// drag the card horizontally; past a threshold it flies off and fires
// onSwipe('right' | 'left'). The parent maps that to a grade.

const SWIPE_THRESHOLD = 90;

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

function CardFace({ side, text, img, sound, resolve, audioRef }) {
  const imgSrc = img ? resolve(img) : null;
  const soundSrc = sound ? resolve(sound) : null;

  const replay = (e) => {
    e.stopPropagation(); // don't flip the card
    const a = audioRef?.current;
    if (a) { try { a.currentTime = 0; } catch { /* not seekable yet */ } a.play().catch(() => {}); }
  };

  return (
    <div className={`flashcard-face flashcard-face--${side}`}>
      {imgSrc && (
        <div className="flashcard-media">
          <img src={imgSrc} alt="" draggable={false} />
        </div>
      )}
      {text && <div className="flashcard-text">{text}</div>}
      {soundSrc && (
        <>
          <audio ref={audioRef} src={soundSrc} preload="auto" />
          <button
            type="button"
            className="flashcard-audio-btn"
            onClick={replay}
            onPointerDown={(e) => e.stopPropagation()} // don't start a swipe
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

function CustomCardSlot({ orientation, className }) {
  return (
    <div className={`flashcard flashcard--${orientation} flashcard--static flashcard--custom ${className}`}>
      <div className="flashcard-inner">
        <div className="flashcard-face flashcard-custom-slot">
          <span className="flashcard-custom-badge">Custom</span>
          <p className="flashcard-custom-note">
            Custom card rendering is not yet implemented.
          </p>
        </div>
      </div>
    </div>
  );
}

const Flashcard = forwardRef(function Flashcard({
  card,
  face = 'front',
  onFlip,
  onSwipe,                   // (dir: 'right' | 'left') => void — enables swipe-to-grade
  orientation = 'landscape',
  variant = 'full',          // 'full' (flip canvas) | 'static' (no flip)
  resolveMedia,              // (ref) => url; defaults to identity (e.g. object URLs)
  className = '',
}, ref) {
  const frontAudioRef = useRef(null);
  const backAudioRef = useRef(null);
  const isStatic = variant === 'static';
  const isCustom = !!card?.isCustom;

  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const committedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const startXRef = useRef(0);

  // The shared fly-out: drives the card off-screen in `dir` and resolves once
  // (true) when committed, or false if a fly-out is already in flight. Both a
  // pointer swipe and a programmatic button press (via the imperative handle)
  // funnel through here so the animation is identical.
  const flyOut = useCallback((dir) => new Promise((resolve) => {
    if (committedRef.current) { resolve(false); return; }
    committedRef.current = true;
    setDrag(dir === 'right' ? 700 : -700);
    window.setTimeout(() => resolve(true), 200);
  }), []);

  useImperativeHandle(ref, () => ({ flyOut }), [flyOut]);

  // Auto-play the audio of whichever face is now showing; pause/reset the other.
  // No autoplay for static previews. Hooks must run before any early return.
  useEffect(() => {
    if (isStatic || isCustom) return;
    const active = face === 'back' ? backAudioRef.current : frontAudioRef.current;
    const other = face === 'back' ? frontAudioRef.current : backAudioRef.current;
    if (other) { other.pause(); try { other.currentTime = 0; } catch { /* ignore */ } }
    if (active) { try { active.currentTime = 0; } catch { /* ignore */ } active.play().catch(() => {}); }
  }, [face, isStatic, isCustom]);

  if (isCustom) {
    return <CustomCardSlot orientation={orientation} className={className} />;
  }

  const resolve = resolveMedia ?? ((ref) => ref);
  const v = card?.vanillaData ?? {};
  const media = v.media ?? {};

  const front = (
    <CardFace side="front" text={v.frontText} img={media.front_img} sound={media.front_sound} resolve={resolve} audioRef={frontAudioRef} />
  );
  const back = (
    <CardFace side="back" text={v.backText} img={media.back_img} sound={media.back_sound} resolve={resolve} audioRef={backAudioRef} />
  );

  if (isStatic) {
    return (
      <div className={`flashcard flashcard--${orientation} flashcard--static ${className}`}>
        <div className="flashcard-inner">{face === 'back' ? back : front}</div>
      </div>
    );
  }

  // Swipe-to-grade is only live once the answer is revealed.
  const swipeEnabled = !!onSwipe && face === 'back';

  const flip = () => onFlip?.(face === 'front' ? 'back' : 'front');

  const onClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    flip();
  };

  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return; // not from the focused replay button
    if (e.key === 'Enter' || e.key === ' ') {
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
    if (movedRef.current) suppressClickRef.current = true; // a drag is not a tap
    const dx = e.clientX - startXRef.current;
    if (Math.abs(dx) >= SWIPE_THRESHOLD) {
      const dir = dx > 0 ? 'right' : 'left';
      flyOut(dir).then((ok) => { if (ok) onSwipe(dir); });
    } else {
      setDrag(0);                              // snap back
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
      className={`flashcard flashcard--${orientation} ${className}`}
      data-face={face}
      role="button"
      tabIndex={0}
      aria-label={`Flashcard showing ${face} side. Activate to flip.`}
      style={dragStyle}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {swipeEnabled && dragging && (
        <>
          <span className="flashcard-swipe-hint flashcard-swipe-hint--good"
            style={{ opacity: Math.max(0, Math.min(drag / SWIPE_THRESHOLD, 1)) }}>Good</span>
          <span className="flashcard-swipe-hint flashcard-swipe-hint--again"
            style={{ opacity: Math.max(0, Math.min(-drag / SWIPE_THRESHOLD, 1)) }}>Again</span>
        </>
      )}
      <div className="flashcard-inner">
        {front}
        {back}
      </div>
    </div>
  );
});

export default Flashcard;
