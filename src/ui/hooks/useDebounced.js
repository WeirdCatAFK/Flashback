import { useCallback, useEffect, useRef } from 'react';

/** Calls fn once the calls stop for ms, and drops a pending call when the component unmounts. Pass a stable fn. */
export default function useDebounced(fn, ms) {
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((...args) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), ms);
  }, [fn, ms]);
}
