/**
 * The editor's cross-tab state: which tabs are dirty, their unsaved drafts, the
 * active document's sidecar facts (highlights, cards, tags), and the reconciliation
 * that happens during render — a path change resets the per-document state, a
 * relocation remaps it, a closed tab drops it — so the view converges in one pass
 * rather than flashing through an effect. Drafts live here, not in the renderer,
 * which is what lets them survive a rollback remount.
 */

import { useState, useCallback } from "react";
import { readFile, updateMetadata } from "../../api/documents";
import { useDataInvalidation } from "../../utils/dataBus";
import {
  relocateSet,
  relocateMap,
  pruneSet,
  pruneMap,
  toggleIn,
  setOrDelete,
} from "./tabsState.js";

export default function useDocumentEditor({ activeTab, openTabs, relocation }) {
  const [dirtyPaths, setDirtyPaths] = useState(() => new Set());
  const [drafts, setDrafts] = useState(() => new Map());
  const [highlights, setHighlights] = useState([]);
  const [flashcards, setFlashcards] = useState([]);
  const [tags, setTags] = useState([]);
  const [excludedTags, setExcludedTags] = useState([]);
  const [dataVersion, setDataVersion] = useState(0);

  const applyMeta = useCallback((meta) => {
    setFlashcards(meta?.flashcards ?? []);
    setTags(meta?.tags ?? []);
    setExcludedTags(meta?.excludedTags ?? []);
  }, []);

  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (prevActiveTab !== activeTab) {
    setPrevActiveTab(activeTab);
    setHighlights([]);
    applyMeta({});
  }

  const [prevRelocation, setPrevRelocation] = useState(relocation);
  if (prevRelocation !== relocation) {
    setPrevRelocation(relocation);
    if (relocation) {
      const { from, to } = relocation;
      setDirtyPaths((set) => relocateSet(set, from, to));
      setDrafts((map) => relocateMap(map, from, to));
    }
  }

  const [syncedTabs, setSyncedTabs] = useState(openTabs);
  if (syncedTabs !== openTabs) {
    setSyncedTabs(openTabs);
    const openSet = new Set(openTabs.map((tab) => tab.path));
    setDirtyPaths((set) => pruneSet(set, openSet));
    setDrafts((map) => pruneMap(map, openSet));
  }

  const refreshSidecar = useCallback(
    async (path) => {
      try {
        const meta = (await readFile(path)).metadata ?? {};
        if (path === activeTab) {
          setHighlights(meta.highlights ?? []);
          applyMeta(meta);
        }
      } catch {}
    },
    [activeTab, applyMeta],
  );

  useDataInvalidation(() => {
    setDataVersion((v) => v + 1);
    if (activeTab) refreshSidecar(activeTab);
  });

  const handleTagsChange = useCallback(
    async (newTags, newExcludedTags) => {
      if (!activeTab) return;
      const meta = (await readFile(activeTab)).metadata ?? {};
      await updateMetadata(
        activeTab,
        { ...meta, tags: newTags, excludedTags: newExcludedTags },
        false,
      );
      setTags(newTags);
      setExcludedTags(newExcludedTags);
    },
    [activeTab],
  );

  return {
    dirtyPaths,
    drafts,
    highlights,
    flashcards,
    tags,
    excludedTags,
    dataVersion,
    refreshSidecar,
    handleTagsChange,
    handleDirtyChange: useCallback(
      (path, isDirty) => setDirtyPaths((set) => toggleIn(set, path, isDirty)),
      [],
    ),
    handleDraftChange: useCallback(
      (path, content) => setDrafts((map) => setOrDelete(map, path, content)),
      [],
    ),
    handleHighlightsChange: useCallback(
      (path, hls) => {
        if (path === activeTab) setHighlights(hls ?? []);
      },
      [activeTab],
    ),
    handleSidecarRefresh: useCallback(
      (path, meta) => {
        if (path === activeTab) applyMeta(meta);
      },
      [activeTab, applyMeta],
    ),
  };
}
