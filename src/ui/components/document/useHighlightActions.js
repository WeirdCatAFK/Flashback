/**
 * What the selection toolbar, the finder and a renderer's figure button do to
 * highlights and cards: paint or recolour (a selection, or a clicked highlight by
 * id), remove (asking first, in place, when
 * cards hang off the highlight — `pendingRemoval.from` says whether the toolbar or
 * the finder asked, so the question appears where it was raised), open the card
 * editor with a draft, and scroll to a highlight another view asked for. One
 * highlight is one save, so a created or recoloured highlight is committed on the
 * spot.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { cardsForHighlight, withoutHighlightCards } from "./tabsState.js";

const DEFAULT_HL_COLOR = "amber";
const JUMP_DELAY = 80;

export default function useHighlightActions({
  activeTab,
  highlights,
  flashcards,
  highlightRef,
  saveRef,
  selection,
  clearSelection,
  refreshSidecar,
  pendingHighlight,
  onHighlightConsumed,
}) {
  const [cardDraft, setCardDraft] = useState(null);
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const onConsumedRef = useRef(onHighlightConsumed);
  onConsumedRef.current = onHighlightConsumed;

  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (prevActiveTab !== activeTab) {
    setPrevActiveTab(activeTab);
    setCardDraft(null);
    setPendingRemoval(null);
  }

  const save = (transform) => saveRef.current?.(transform);
  const openNewCard = (draft) => setCardDraft(draft ?? {});

  const highlight = useCallback(
    (color) => {
      const res = highlightRef.current?.toggle?.(color);
      clearSelection();
      if (res?.kind === "created" || res?.kind === "recolored")
        saveRef.current?.();
    },
    [highlightRef, saveRef, clearSelection],
  );

  const requestRemoval = (id, from, remove) => {
    const count = id ? cardsForHighlight(flashcards, id) : 0;
    if (count > 0) {
      setPendingRemoval({ id, cardCount: count, from });
      return;
    }
    remove();
  };

  const unhighlight = () => {
    const id = highlightRef.current?.currentId?.();
    requestRemoval(id, "toolbar", () => {
      highlightRef.current?.unset?.();
      clearSelection();
      save();
    });
  };

  const deleteHighlight = (id, from = "finder") => {
    if (!id) return;
    requestRemoval(id, from, () => {
      const res = highlightRef.current?.remove?.(id);
      if (from === "toolbar") clearSelection();
      if (res?.kind === "removed") save();
    });
  };

  /** A clicked highlight takes another colour; one recolour is one save. */
  const recolor = (id, color) => {
    const res = highlightRef.current?.recolor?.(id, color);
    clearSelection();
    if (res?.kind === "recolored") save();
  };

  const resolveRemoval = (deleteCards) => {
    const id = pendingRemoval?.id;
    setPendingRemoval(null);
    if (id) highlightRef.current?.remove?.(id);
    else highlightRef.current?.unset?.();
    clearSelection();
    save(
      deleteCards && id ? (meta) => withoutHighlightCards(meta, id) : undefined,
    );
  };

  const makeCard = () => {
    const text = selection?.text ?? "";
    const res = highlightRef.current?.ensure?.(DEFAULT_HL_COLOR);
    if (res?.id) {
      const color =
        res.kind === "created"
          ? DEFAULT_HL_COLOR
          : (highlights.find((h) => h.id === res.id)?.color ??
            DEFAULT_HL_COLOR);
      openNewCard({ text, highlightId: res.id, color });
      if (res.kind === "created") save();
    } else {
      openNewCard(text ? { text, highlightId: null, color: null } : null);
    }
    clearSelection();
  };

  const pickImage = (image) => {
    if (!image?.href) return;
    clearSelection();
    openNewCard({ text: "", highlightId: null, color: null, image });
  };

  const cardSaved = () => {
    clearSelection();
    if (activeTab) refreshSidecar(activeTab);
  };

  const cardFromHighlight = (highlightId) => {
    const h = highlights.find((x) => x.id === highlightId);
    openNewCard({
      text: h?.text ?? "",
      highlightId,
      color: h?.color ?? DEFAULT_HL_COLOR,
    });
  };

  useEffect(() => {
    if (!pendingHighlight || pendingHighlight.path !== activeTab)
      return undefined;
    const targetId = pendingHighlight.id;
    if (!highlights.some((h) => h.id === targetId)) return undefined;
    const timer = setTimeout(() => {
      highlightRef.current?.scrollTo?.(targetId);
      onConsumedRef.current?.();
    }, JUMP_DELAY);
    return () => clearTimeout(timer);
  }, [highlights, pendingHighlight, activeTab, highlightRef]);

  return {
    cardDraft,
    closeCardDraft: () => setCardDraft(null),
    pendingRemoval,
    highlight,
    unhighlight,
    deleteHighlight,
    recolor,
    resolveRemoval,
    makeCard,
    pickImage,
    cardSaved,
    cardFromHighlight,
    cancelRemoval: () => setPendingRemoval(null),
    jumpToHighlight: (id) => highlightRef.current?.scrollTo?.(id),
  };
}
