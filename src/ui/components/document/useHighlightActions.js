/**
 * What the toolbar, the inspector and a renderer's figure button do to
 * highlights and cards: paint or recolour, remove (asking first when cards hang
 * off the highlight), open the card form with a draft, and scroll to a highlight
 * another view asked for. One highlight is one save, so a created or recoloured
 * highlight is committed on the spot.
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
  const [inspectorTab, setInspectorTab] = useState("cards");
  const [cardDraft, setCardDraft] = useState(null);
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const onConsumedRef = useRef(onHighlightConsumed);
  onConsumedRef.current = onHighlightConsumed;

  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (prevActiveTab !== activeTab) {
    setPrevActiveTab(activeTab);
    setInspectorTab("cards");
    setCardDraft(null);
    setPendingRemoval(null);
  }

  const save = (transform) => saveRef.current?.(transform);
  const openNewCard = (draft) => {
    setCardDraft(draft);
    setInspectorTab("new-card");
  };

  const highlight = useCallback(
    (color) => {
      const res = highlightRef.current?.toggle?.(color);
      clearSelection();
      if (res?.kind === "created" || res?.kind === "recolored")
        saveRef.current?.();
    },
    [highlightRef, saveRef, clearSelection],
  );

  const requestRemoval = (id, remove) => {
    const count = id ? cardsForHighlight(flashcards, id) : 0;
    if (count > 0) {
      setPendingRemoval({ id, cardCount: count });
      return;
    }
    remove();
  };

  const unhighlight = () => {
    const id = highlightRef.current?.currentId?.();
    requestRemoval(id, () => {
      highlightRef.current?.unset?.();
      clearSelection();
      save();
    });
  };

  const deleteHighlight = (id) => {
    if (!id) return;
    requestRemoval(id, () => {
      const res = highlightRef.current?.remove?.(id);
      if (res?.kind === "removed") save();
    });
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
    setCardDraft(null);
    setInspectorTab("cards");
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

  const changeInspectorTab = (tab) => {
    setInspectorTab(tab);
    if (tab !== "new-card") {
      clearSelection();
      setCardDraft(null);
    }
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
    inspectorTab,
    cardDraft,
    pendingRemoval,
    highlight,
    unhighlight,
    deleteHighlight,
    resolveRemoval,
    makeCard,
    pickImage,
    cardSaved,
    cardFromHighlight,
    changeInspectorTab,
    cancelRemoval: () => setPendingRemoval(null),
    jumpToHighlight: (id) => highlightRef.current?.scrollTo?.(id),
  };
}
