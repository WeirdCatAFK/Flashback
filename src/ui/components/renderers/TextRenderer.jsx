import { useEffect, useRef, useState } from 'react';
import { readFile, updateFile } from '../../api/documents';
import './Renderer.css';

export default function TextRenderer({ path, onDirtyChange, saveRef, draftContent, onDraftChange }) {
  const [value, setValue]   = useState('');
  const [loading, setLoading] = useState(true);

  const diskContentRef = useRef('');
  const isDirtyRef     = useRef(false);
  // Snapshot read once per path change — never drives re-runs
  const draftRef = useRef(draftContent);
  draftRef.current = draftContent;

  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    try {
      await updateFile(path, value);
      diskContentRef.current = value;
      isDirtyRef.current = false;
      onDirtyChange?.(path, false);
      onDraftChange?.(path, undefined);
    } catch {
      // dirty indicator stays; user can retry with Ctrl+S
    }
  };

  // Register with DocumentEditor's saveRef
  useEffect(() => {
    if (saveRef) saveRef.current = () => handleSaveRef.current?.();
    return () => { if (saveRef) saveRef.current = null; };
  });

  useEffect(() => {
    if (!path) return;

    const draft = draftRef.current;

    if (draft !== undefined) {
      // Restore from draft instantly — no fetch, no loading flash
      setValue(draft);
      isDirtyRef.current = true;
      return;
    }

    setLoading(true);
    isDirtyRef.current = false;
    onDirtyChange?.(path, false);

    readFile(path)
      .then(data => {
        const text = data.content ?? '';
        diskContentRef.current = text;
        setValue(text);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleChange = (e) => {
    const next = e.target.value;
    setValue(next);
    onDraftChange?.(path, next);
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      onDirtyChange?.(path, true);
    }
  };

  if (loading) return <div className="renderer-loading">Loading…</div>;

  return (
    <textarea
      className="text-editor"
      value={value}
      onChange={handleChange}
      spellCheck={false}
    />
  );
}
