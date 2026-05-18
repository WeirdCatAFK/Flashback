import './EditorTitleBar.css';

export default function EditorTitleBar({ path }) {
  if (!path) return <div className="editor-title-bar" />;

  const parts = path.replace(/\\/g, '/').split('/');
  const filename = parts.pop();
  const folders = parts;

  return (
    <div className="editor-title-bar">
      {folders.map((part, i) => (
        <span key={i} className="title-bar-path-segment">
          {part}
          <span className="title-bar-sep">/</span>
        </span>
      ))}
      <span className="title-bar-filename">{filename}</span>
    </div>
  );
}
