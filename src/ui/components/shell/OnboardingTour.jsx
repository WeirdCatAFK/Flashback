/**
 * OnboardingTour — the replayable spotlight walk through the activity bar, gated
 * on localStorage; a scrim with a cutout and a callout per step.
 *
 * A step that points at a screen takes its title from the activity bar's own label
 * (`labels`, App's navLabels), so the tour and the tab it points at never disagree, and
 * the Diary step reads "Logs" on a server as the tab does. The callout says what each
 * screen holds and what you do there, in the same plain register as the screens: no
 * selling. Progress is a thin line across its top and a count, as elsewhere.
 */

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
import IconDiary from "../icons/IconDiary";
import { useT } from "../../translations/index";
import "./OnboardingTour.css";

/** A small inline mark for the target-less welcome/finish steps. */
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
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/**
 * A function of `t` rather than a module constant: the prose here is the bulk of
 * the tour, and a constant would be evaluated once at import and keep the old
 * language after a switch. `target`, `view` and `Icon` are structural; a step with a
 * `view` and no `title` is titled by that view's tab.
 */
const stepsFor = (t) => [
  {
    Icon: IconMark,
    title: t("Welcome to Flashback"),
    body: t("A short walk along the bar on the left. The app is live behind this, so each screen opens as it is described. The arrow keys move through the tour and Esc closes it."),
  },
  {
    target: '[data-tour="nav-documents"]',
    view: "documents",
    Icon: IconDocuments,
    body: t("Your vault’s files: Markdown, PDFs, web pages and videos, in folders you own. Select a passage while reading to highlight it, then make a card from the highlight."),
  },
  {
    target: '[data-tour="nav-flashcards"]',
    view: "flashcards",
    Icon: IconFlashcards,
    body: t("Every card in the vault in one list, to search, filter and edit. A card can be basic, reversible, cloze, typed, or your own HTML."),
  },
  {
    target: '[data-tour="nav-decks"]',
    view: "decks",
    Icon: IconDecks,
    body: t("Boxes you pack with cards to study together; a card can sit in several. Anki packages and Obsidian vaults are imported here."),
  },
  {
    target: '[data-tour="nav-trainer"]',
    view: "trainer",
    Icon: IconTrainer,
    body: t("The cards that are due, one at a time. Each grade shows the gap it set before the card comes back. The scheduler (Leitner, SM-2 or FSRS) is chosen in Config → Study."),
  },
  {
    target: '[data-tour="nav-stats"]',
    view: "stats",
    Icon: IconStats,
    body: t("How your memory is holding up: what you recall, what is coming due, and how far apart the cards have spread."),
  },
  {
    target: '[data-tour="nav-diary"]',
    view: "diary",
    Icon: IconDiary,
    body: t("Each day you studied, with a summary of what was reviewed and room to write about it."),
  },
  {
    target: '[data-tour="nav-graph"]',
    view: "graph",
    Icon: IconGraph,
    body: t("The vault as a map: documents, folders, cards, tags and decks, and the links between them, lit by what you know."),
  },
  {
    target: '[data-tour="nav-seal"]',
    view: "seal",
    Icon: IconSeal,
    body: t("Every change to your documents is kept. Restore any earlier point, and run the Vault Doctor to check the vault’s files."),
  },
  {
    target: '[data-tour="nav-manage"]',
    view: "manage",
    Icon: IconManage,
    body: t("Categories say what a card is for: a definition, a concept, an application. Tags are here too, with how widely each is used."),
  },
  {
    target: "#search-btn",
    Icon: IconSearch,
    title: t("Search"),
    body: t("Ctrl+K from anywhere finds a document, card, tag or deck. Prefixes such as tag:, deck: and doc: narrow it, and a tag on a folder covers everything inside it."),
  },
  {
    view: "documents",
    Icon: IconMark,
    title: t("That’s the tour"),
    body: t("You can take it again from Config → About."),
  },
];

const PAD = 6;
const GAP = 14;
const EDGE = 12;

export default function OnboardingTour({ onClose, onNavigate, labels = {} }) {
  const { t } = useT();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const [pos, setPos] = useState(null);
  const calloutRef = useRef(null);

  const steps = stepsFor(t);
  const total = steps.length;
  const isLast = step === total - 1;
  const current = steps[step];
  const { Icon } = current;
  const title = current.title ?? labels[current.view] ?? "";

  const next = useCallback(
    () => (isLast ? onClose() : setStep((s) => Math.min(total - 1, s + 1))),
    [isLast, onClose, total]
  );
  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

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
      else setRect(null);
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
    <div className="spot-overlay" role="dialog" aria-modal="true" aria-label={t('Welcome tour')}>
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
        <span className="spot-line" aria-hidden="true">
          <i style={{ width: `${((step + 1) / total) * 100}%` }} />
        </span>
        <div className="spot-head">
          <span className="spot-icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <h2 className="spot-title">{title}</h2>
          <span className="spot-count" aria-label={t('Step {step} of {total}', { step: step + 1, total })}>
            {step + 1} / {total}
          </span>
        </div>
        <p className="spot-body">{current.body}</p>

        <div className="spot-footer">
          {!isLast && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
              {t('Skip')}
            </button>
          )}
          <span className="spot-grow" />
          {step > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={back}>
              {t('Back')}
            </button>
          )}
          <button type="button" className="btn btn--quiet-accent btn--sm" onClick={next} autoFocus>
            {isLast ? t('Done') : t('Next')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
