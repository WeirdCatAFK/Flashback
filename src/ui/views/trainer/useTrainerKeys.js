/**
 * Window-level keyboard shortcuts for the trainer. Ignores keys typed into a
 * field, resolves the pressed key against the user's keybindings, and hands the
 * handler a `hits(actionId)` predicate. The handler is held in a ref so the
 * listener registers once per `isActive` flip.
 */

import { useEffect, useRef } from 'react';
import useKeybindings from '../../hooks/useKeybindings';
import { eventKeyName } from '../../keybindings';

const isEditable = (el) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/**
 * @param {boolean} isActive
 * @param {(hits: (actionId: string) => boolean, e: KeyboardEvent) => void} handler
 * @returns the live keybinding map, for rendering keycaps
 */
export default function useTrainerKeys(isActive, handler) {
  const keymap = useKeybindings();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;

  useEffect(() => {
    if (!isActive) return undefined;
    const onKey = (e) => {
      if (isEditable(e.target)) return;
      const name = eventKeyName(e);
      const hits = (id) => (keymapRef.current[id] ?? []).includes(name);
      handlerRef.current(hits, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  return keymap;
}
