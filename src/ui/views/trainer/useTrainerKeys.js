import { useEffect, useRef } from 'react';
import useKeybindings from '../../hooks/useKeybindings';
import { eventKeyName } from '../../utils/keybindings';

const isEditable = (el) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

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
