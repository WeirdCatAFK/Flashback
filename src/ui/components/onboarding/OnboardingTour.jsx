import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import IconDocuments from "../icons/IconDocuments";
import IconFlashcards from "../icons/IconFlashcards";
import IconDecks from "../icons/IconDecks";
import IconGraph from "../icons/IconGraph";
import IconTrainer from "../icons/IconTrainer";
import IconManage from "../icons/IconManage";
import IconSeal from "../icons/IconSeal";
import IconStats from "../icons/IconStats";
import "./OnboardingTour.css";

/**
 * OnboardingTour — the replayable feature walkthrough. This is the "onboarding"
 * proper, and unlike a plain slideshow it is an *interactive spotlight*: it dims
 * the running app, rings the real UI element for each feature, switches the live
 * view behind the dim so the section is genuinely on screen, and floats a callout
 * next to the target explaining what it does and how to use it.
 *
 * It writes nothing to config.json and never runs setup — App gates it purely on
 * the `fb-onboarding-seen` localStorage flag (auto-once) and the Config replay
 * button, and mounts it inside AppGate so the shell (and its nav) already exist.
 *
 * Setup (vault creation) lives separately in views/Setup.jsx, gated by isFirstRun().
 */

// A small inline mark for the target-less welcome/finish steps.
function IconMark({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" aria-hidden="true">
      <path d="M26 6L46 26L26 46L6 26Z" stroke="currentColor" strokeWidth="2.5" />
      <path d="M26 16L36 26L26 36L16 26Z" fill="currentColor" />
    </svg>
  );
}

function IconSearch({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────
// Each step points a spotlight at a live element (`target`, a CSS selector), and
// optionally switches the app to a `view` first so the real section shows behind
// the dim. Target-less steps (welcome / finish) render a centered card.

const STEPS = [
  {
    Icon: IconMark,
    title: "Welcome to Flashback",
    body: "Your notes, documents, and flashcards in one place, built for spaced repetition. This quick tour points out where each feature lives and how to use it — the app is live behind this, so follow along.",
  },
  {
    target: '[data-tour="nav-documents"]',
    view: "documents",
    Icon: IconDocuments,
    title: "Documents & your vault",
    body: "This opens your vault — a folder of files you own. Browse the tree on the left and open Markdown, PDFs, text, YouTube, or web clips. While reading, select any passage to highlight it and turn that highlight straight into a flashcard.",
  },
  {
    target: '[data-tour="nav-flashcards"]',
    view: "flashcards",
    Icon: IconFlashcards,
    title: "Flashcards",
    body: "Every card you make, in one library. Create basic, reversible, cloze, type-answer, or fully custom HTML cards, then filter, search, and edit them here — each card also shows its mastery level.",
  },
  {
    target: '[data-tour="nav-decks"]',
    view: "decks",
    Icon: IconDecks,
    title: "Decks",
    body: "Curate cards into decks for focused study, and import existing collections from Anki (.apkg) or Obsidian (.zip). Study a whole deck in a single session.",
  },
  {
    target: '[data-tour="nav-graph"]',
    view: "graph",
    Icon: IconGraph,
    title: "Knowledge graph",
    body: "See how everything connects — documents, folders, cards, tags, and decks — in an interactive graph. Follow links to discover related material and spot the gaps.",
  },
  {
    target: '[data-tour="nav-trainer"]',
    view: "trainer",
    Icon: IconTrainer,
    title: "The Trainer",
    body: "Review what's due and grade each card from the keyboard. Choose Leitner, SM-2, or FSRS as your scheduling algorithm and Flashback plans the rest.",
  },
  {
    target: '[data-tour="nav-stats"]',
    view: "stats",
    Icon: IconStats,
    title: "Track your progress",
    body: "See how your vault is doing at a glance — retention, review activity, card maturity, and what's coming due. All read-only, derived from your review history.",
  },
  {
    target: '[data-tour="nav-seal"]',
    view: "seal",
    Icon: IconSeal,
    title: "Seal & Vault Doctor",
    body: "Every change is versioned automatically. Browse your history, restore any earlier state, and run the Vault Doctor to check and repair the index — your work is never lost.",
  },
  {
    target: '[data-tour="nav-manage"]',
    view: "manage",
    Icon: IconManage,
    title: "Manage categories & tags",
    body: "The vault-wide metadata that shapes your whole knowledge base. Edit pedagogical categories — classify cards by learning purpose (definition, concept, application…) to build proper study material — and see every tag and how widely it's used.",
  },
  {
    target: "#search-btn",
    Icon: IconSearch,
    title: "Search everything",
    body: "Press Ctrl+K anywhere to jump to any document, card, tag, or deck. Use prefixes like tag:, deck:, and doc: to narrow results — and since tags inherit down the folder tree, tag: search finds everything beneath a tagged folder.",
  },
  {
    view: "documents",
    Icon: IconMark,
    title: "You're all set",
    body: "That's the tour. Dive in and start building your vault — you can replay this anytime from Config → Getting started.",
  },
];

const PAD = 6;   // ring padding around the target
const GAP = 14;  // gap between target and callout
const EDGE = 12; // keep the callout this far from the viewport edge

// ── Progress dots ───────────────────────────────────────────────────────────

function TourDots({ step, total, onJump }) {
  return (
    <div className="spot-dots" aria-label={`Step ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`spot-dot${i === step ? " spot-dot--active" : i < step ? " spot-dot--done" : ""}`}
          onClick={() => onJump(i)}
          aria-label={`Go to step ${i + 1}`}
          aria-current={i === step ? "true" : undefined}
        />
      ))}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function OnboardingTour({ onClose, onNavigate }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null); // target's viewport rect, or null (centered)
  const [pos, setPos] = useState(null);   // computed callout position
  const calloutRef = useRef(null);

  const total = STEPS.length;
  const isLast = step === total - 1;
  const current = STEPS[step];
  const { Icon } = current;

  const next = useCallback(
    () => (isLast ? onClose() : setStep((s) => Math.min(total - 1, s + 1))),
    [isLast, onClose, total]
  );
  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  // Switch to the step's view, then locate its target element. Views are lazy, so
  // after navigating we retry across a few frames until the element mounts.
  useEffect(() => {
    if (current.view) onNavigate?.(current.view);
    if (!current.target) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let raf = 0;
    let tries = 0;
    const find = () => {
      if (cancelled) return;
      const el = document.querySelector(current.target);
      if (el) {
        setRect(el.getBoundingClientRect());
        return;
      }
      if (tries++ < 90) raf = requestAnimationFrame(find);
      else setRect(null); // give up gracefully → centered card
    };
    find();

    const remeasure = () => {
      const el = document.querySelector(current.target);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [step, current.view, current.target, onNavigate]);

  // Position the callout once it (and the target rect) are known. Prefer the side
  // with room — right → left → below → above → centered — and clamp to the viewport.
  useLayoutEffect(() => {
    const node = calloutRef.current;
    if (!node) return;
    const cw = node.offsetWidth;
    const ch = node.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clampTop = (t) => Math.min(Math.max(t, EDGE), vh - ch - EDGE);
    const clampLeft = (l) => Math.min(Math.max(l, EDGE), vw - cw - EDGE);

    if (!rect) {
      setPos({ top: (vh - ch) / 2, left: (vw - cw) / 2, placement: "center" });
      return;
    }
    const midY = rect.top + rect.height / 2 - ch / 2;
    const midX = rect.left + rect.width / 2 - cw / 2;
    if (rect.right + GAP + cw <= vw - EDGE) {
      setPos({ top: clampTop(midY), left: rect.right + GAP, placement: "right" });
    } else if (rect.left - GAP - cw >= EDGE) {
      setPos({ top: clampTop(midY), left: rect.left - GAP - cw, placement: "left" });
    } else if (rect.bottom + GAP + ch <= vh - EDGE) {
      setPos({ top: rect.bottom + GAP, left: clampLeft(midX), placement: "bottom" });
    } else if (rect.top - GAP - ch >= EDGE) {
      setPos({ top: rect.top - GAP - ch, left: clampLeft(midX), placement: "top" });
    } else {
      setPos({ top: (vh - ch) / 2, left: (vw - cw) / 2, placement: "center" });
    }
  }, [rect, step]);

  // Keyboard: Esc skips, arrows navigate.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [next, back, onClose]);

  const ringStyle = rect
    ? {
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + 2 * PAD,
        height: rect.height + 2 * PAD,
      }
    : null;

  return createPortal(
    <div className="spot-overlay" role="dialog" aria-modal="true" aria-label="Welcome tour">
      {rect ? (
        <div className="spot-ring" style={ringStyle} aria-hidden="true" />
      ) : (
        <div className="spot-fulldim" aria-hidden="true" />
      )}

      <div
        ref={calloutRef}
        className="spot-callout"
        data-placement={pos?.placement}
        style={pos ? { top: pos.top, left: pos.left } : { opacity: 0 }}
      >
        <div className="spot-head">
          <span className="spot-icon" aria-hidden="true">
            <Icon size={20} />
          </span>
          <h2 className="spot-title">{current.title}</h2>
        </div>
        <p className="spot-body">{current.body}</p>

        <div className="spot-footer">
          <button type="button" className="spot-btn spot-btn--ghost" onClick={onClose}>
            Skip
          </button>
          <TourDots step={step} total={total} onJump={setStep} />
          <div className="spot-footer-right">
            {step > 0 && (
              <button type="button" className="spot-btn spot-btn--ghost" onClick={back}>
                Back
              </button>
            )}
            <button type="button" className="spot-btn spot-btn--primary" onClick={next}>
              {isLast ? "Get started" : "Next"}
              {!isLast && (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <line x1="2" y1="7" x2="12" y2="7" />
                  <polyline points="8,3 12,7 8,11" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
