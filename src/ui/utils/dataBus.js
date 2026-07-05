import { useEffect, useRef } from 'react';

// A lightweight app-wide "the vault changed underneath you" signal.
//
// Most views keep their server state in local hooks and are kept mounted after
// their first visit (see App.jsx's view-slot keep-alive). Views that refetch on
// `isActive` naturally pick up changes when you switch back to them, but the
// file explorer tree, open document content, Flashcards, and Decks load once and
// never re-poll — so a Seal rollback or Vault Doctor sync/rebuild leaves them
// showing pre-restore data until a manual reload.
//
// `invalidateData()` broadcasts that the canonical files and/or derived index
// were rewritten out from under the UI; subscribers re-run their primary fetch.
// It's a plain window Event (matching the keybindings-change pattern in
// keybindings.js) so it needs no provider and crosses every view boundary.

const DATA_INVALIDATED = 'flashback:data-invalidated';

export function invalidateData() {
    window.dispatchEvent(new Event(DATA_INVALIDATED));
}

// Subscribe a component to data-invalidation events. The callback is held in a
// ref so the listener is registered once and always calls the latest closure —
// callers don't need to memoize what they pass in.
export function useDataInvalidation(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(DATA_INVALIDATED, handler);
        return () => window.removeEventListener(DATA_INVALIDATED, handler);
    }, []);
}
