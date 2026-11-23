import { useEffect, useState } from 'react';
import { loadKeybindings, KB_EVENT } from '../utils/keybindings';

export default function useKeybindings() {
  const [map, setMap] = useState(loadKeybindings);

  useEffect(() => {
    const sync = () => setMap(loadKeybindings());
    window.addEventListener(KB_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(KB_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return map;
}
