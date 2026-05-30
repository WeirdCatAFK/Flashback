import { useCallback, useEffect, useState } from 'react';

const KEY = 'fb-flashcard-orientation';
const EVENT = 'fb-flashcard-orientation-change';

function read() {
  const v = localStorage.getItem(KEY);
  return v === 'portrait' || v === 'landscape' ? v : 'landscape';
}

/**
 * @returns {['landscape' | 'portrait', (next: 'landscape' | 'portrait') => void]}
 */
export default function useFlashcardOrientation() {
  const [orientation, setOrientation] = useState(read);

  useEffect(() => {
    const sync = () => setOrientation(read());
    window.addEventListener(EVENT, sync);       // same-window updates
    window.addEventListener('storage', sync);   // other windows
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((next) => {
    localStorage.setItem(KEY, next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [orientation, update];
}
