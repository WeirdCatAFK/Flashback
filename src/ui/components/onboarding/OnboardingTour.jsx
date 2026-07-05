import { useState } from "react";
import Modal from "../shared/Modal";
import IconDocuments from "../icons/IconDocuments";
import IconFlashcards from "../icons/IconFlashcards";
import IconDecks from "../icons/IconDecks";
import IconGraph from "../icons/IconGraph";
import IconTrainer from "../icons/IconTrainer";
import IconSeal from "../icons/IconSeal";
import "./OnboardingTour.css";

/**
 * OnboardingTour — the replayable feature walkthrough. This is the "onboarding"
 * proper: a centered slideshow of what Flashback does. It writes nothing to
 * config.json and never runs setup — App gates it purely on the
 * `fb-onboarding-seen` localStorage flag (auto-once) and the Config replay button.
 *
 * Setup (vault creation) lives separately in views/Setup.jsx, gated by isFirstRun().
 */

// ── Slide artwork ───────────────────────────────────────────────────────────
// Existing nav icons are reused where they exist; the rest are small inline SVGs
// so the tour stays self-contained. All strokes/fills use theme tokens.

function IconMark({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" aria-hidden="true">
      <path d="M26 6L46 26L26 46L6 26Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M26 16L36 26L26 36L16 26Z" fill="currentColor" />
    </svg>
  );
}

function IconHighlight({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15l7-7 5 5-7 7H4v-5z" />
      <path d="M13 6l3-3 5 5-3 3" />
      <line x1="3" y1="21" x2="21" y2="21" />
    </svg>
  );
}

function IconCategories({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="14" width="12" height="4" rx="1" />
      <line x1="19" y1="14" x2="19" y2="18" />
      <line x1="21" y1="16" x2="17" y2="16" />
    </svg>
  );
}

function IconTags({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.6 13.4L12 22l-9-9V4h9l8.6 8.6a1.4 1.4 0 0 1 0 2z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

function IconSearch({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

// ── Slides ──────────────────────────────────────────────────────────────────

const SLIDES = [
  {
    Icon: IconMark,
    title: "Welcome to Flashback",
    body: "A knowledge database with everything you need for spaced repetition — your notes, documents, and flashcards in one place. Here's a quick tour of what it can do.",
  },
  {
    Icon: IconDocuments,
    title: "Documents & your vault",
    body: "Everything lives in a vault — a folder of files you own. Browse the tree in the explorer and open Markdown, PDFs, text, YouTube videos, and web clips right inside the app.",
  },
  {
    Icon: IconHighlight,
    title: "Highlight & capture",
    body: "Select any passage while reading to highlight it in one of four colors — then turn that highlight straight into a flashcard or reference, anchored back to its exact spot in the source.",
  },
  {
    Icon: IconFlashcards,
    title: "Flashcards",
    body: "Create basic, reversible, cloze, type-answer, or fully custom HTML cards. The Flashcards library shows every card, its mastery level, and lets you filter, search, and edit them.",
  },
  {
    Icon: IconCategories,
    title: "Pedagogical categories",
    body: "Classify each card by its learning purpose — definition, concept, application, and so on. Categories (managed in Settings → Flashcards) are what let you build proper, well-structured study material instead of a loose pile of cards.",
  },
  {
    Icon: IconTrainer,
    title: "The Trainer",
    body: "Review what's due and grade each card Again, Good, or Easy — all from the keyboard. Pick Leitner or SM-2 as your scheduling algorithm; Flashback plans the rest.",
  },
  {
    Icon: IconDecks,
    title: "Decks",
    body: "Curate cards into decks for focused study, and import existing collections from Anki (.apkg) or Obsidian (.zip). Study a whole deck in one session.",
  },
  {
    Icon: IconGraph,
    title: "Knowledge graph",
    body: "See how everything connects — documents, folders, cards, tags, and decks — in an interactive graph. Follow links to discover related material and spot gaps.",
  },
  {
    Icon: IconTags,
    title: "Tags that inherit",
    body: "Tag a folder and everything inside inherits it automatically. Tags flow down the tree, so organizing once keeps your whole vault searchable and study-ready.",
  },
  {
    Icon: IconSearch,
    title: "Search everything",
    body: "Press Ctrl+K anywhere to jump to any document, card, tag, or deck. Use prefixes like tag:, deck:, and doc: to narrow results instantly.",
  },
  {
    Icon: IconSeal,
    title: "Seal & Vault Doctor",
    body: "Every change is versioned automatically. Browse your history, restore any earlier state, and use the Vault Doctor to check and repair the index — your work is never lost.",
  },
  {
    Icon: IconMark,
    title: "You're all set",
    body: "That's the tour. Dive in and start building your vault — and you can replay this anytime from Settings → Getting started.",
  },
];

// ── Progress dots ─────────────────────────────────────────────────────────────

function TourDots({ step, total, onJump }) {
  return (
    <div className="tour-dots" aria-label={`Slide ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`tour-dot${i === step ? " tour-dot--active" : i < step ? " tour-dot--done" : ""}`}
          onClick={() => onJump(i)}
          aria-label={`Go to slide ${i + 1}`}
          aria-current={i === step ? "true" : undefined}
        />
      ))}
    </div>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────

export default function OnboardingTour({ onClose }) {
  const [step, setStep] = useState(0);
  const total = SLIDES.length;
  const isLast = step === total - 1;
  const slide = SLIDES[step];
  const { Icon } = slide;

  const next = () => (isLast ? onClose() : setStep((s) => Math.min(total - 1, s + 1)));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const footer = (
    <div className="tour-footer">
      <button type="button" className="tour-btn tour-btn--ghost" onClick={onClose}>
        Skip
      </button>
      <TourDots step={step} total={total} onJump={setStep} />
      <div className="tour-footer-right">
        {step > 0 && (
          <button type="button" className="tour-btn tour-btn--ghost" onClick={back}>
            Back
          </button>
        )}
        <button type="button" className="tour-btn tour-btn--primary" onClick={next}>
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
  );

  return (
    <Modal ariaLabel="Welcome tour" onClose={onClose} size="lg" footer={footer}>
      <div className="tour-slide">
        <div className="tour-icon" aria-hidden="true">
          <Icon size={44} />
        </div>
        <h2 className="tour-title">{slide.title}</h2>
        <p className="tour-body">{slide.body}</p>
      </div>
    </Modal>
  );
}
