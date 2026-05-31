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
// whenever that face is presented and a styled replay button stays available.
//
// Swipe (opt-in via `onSwipe`, only once the answer is revealed — face 'back'):
// drag the card horizontally; past a threshold it flies and fires
// onSwipe('right' | 'left'). The exit is outcome-driven — right/'accept' ascends
// off the top, left/'reject' shakes and drops back into the deck. `flyOut(kind)`
// exposes the same flight imperatively for the grade buttons.

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
  const rootRef = useRef(null);
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

  // The shared flight, driven by the outcome:
  //   'accept' → the card lifts, swells, then ascends off the top and fades.
  //   'reject' → a quick shake, then it drops back down into the deck (stack).
  // Resolves once (true) when committed, or false if already in flight.
  const runFlyOut = useCallback((kind) => new Promise((resolve) => {
    if (committedRef.current) { resolve(false); return; }
    committedRef.current = true;
    const el = rootRef.current;
    if (!el) { resolve(true); return; }

    const start = drag; // where the drag left the card
    let frames;
    let duration;
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

  // Stable imperative handle that always calls the latest runFlyOut.
  const runFlyOutRef = useRef(runFlyOut);
  runFlyOutRef.current = runFlyOut;
  const flyOut = useCallback((kind) => runFlyOutRef.current(kind), []);
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

  const resolve = resolveMedia ?? ((ref2) => ref2);
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
      runFlyOut(dir === 'right' ? 'accept' : 'reject').then((ok) => { if (ok) onSwipe(dir); });
    } else {
      setDrag(0); // snap back
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
      <div className="flashcard-inner">
        {front}
        {back}
      </div>
    </div>
  );
});

export default Flashcard;
