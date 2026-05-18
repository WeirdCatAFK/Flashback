import { useEffect, useState } from 'react';
import { readFile } from '../../api/documents';
import './Renderer.css';

export default function TextRenderer({ path }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    readFile(path)
      .then(data => setContent(data.content ?? ''))
      .catch(err => setError(err))
      .finally(() => setLoading(false));
  }, [path]);

  if (loading) return <div className="renderer-loading">Loading…</div>;
  if (error) return <div className="renderer-error">Could not load file.</div>;

  return <pre className="text-renderer">{content}</pre>;
}
