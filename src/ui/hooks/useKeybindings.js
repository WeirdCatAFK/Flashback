import { useEffect, useState } from 'react';
import { loadKeybindings, KB_EVENT } from '../keybindings';

// Reactive access to the resolved keybinding map. Like the theme state it lives
// in localStorage and broadcasts a custom event, so every mounted consumer
// updates the moment a binding changes.
export default function useKeybindings() {
  const [map, setMap] = useState(loadKeybindings);

  useEffect(() => {
    const sync = () => setMap(loadKeybindings());
    window.addEventListener(KB_EVENT, sync);     // same-window updates
    window.addEventListener('storage', sync);    // other windows
    return () => {
      window.removeEventListener(KB_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return map;
}
