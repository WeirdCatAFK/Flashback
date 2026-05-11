//Vscode inspired file explorer. (An editor only to text based files like markdown, txt and so.)
//This might be the more complex part because apart from being an editor, it has to have flashcard creation and annotation tools.
import { useState, useEffect } from 'react';
import { listFolder, readFile, createFile, createFolder } from '../api/documents';

function useFolderContents(path) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listFolder(path)
      .then(setItems)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [path, rev]);

  return { items, loading, error, refresh: () => setRev(r => r + 1) };
}

function useFileContents(filePath) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!filePath) { setData(null); return; }
    setLoading(true);
    setError(null);
    readFile(filePath)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [filePath]);

  return { data, loading, error };
}

function useCreateItem(onSuccess) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (parentPath, isFolder) => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      isFolder
        ? await createFolder(name.trim(), parentPath)
        : await createFile(name.trim(), parentPath);
      setName('');
      onSuccess();
    } catch (err) {
      setError(err.status === 409 ? `"${name.trim()}" already exists` : err.status === 400 ? err.message : 'Server error');
    } finally {
      setBusy(false);
    }
  };

  return { name, setName, busy, error, submit };
}

function CreateBar({ currentPath, onCreated }) {
  const { name, setName, busy, error, submit } = useCreateItem(onCreated);

  return (
    <div>
      <input
        placeholder="name…"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(currentPath, false); }}
        disabled={busy}
      />
      <button onClick={() => submit(currentPath, false)} disabled={busy || !name.trim()}>
        + File
      </button>
      <button onClick={() => submit(currentPath, true)} disabled={busy || !name.trim()}>
        + Folder
      </button>
      {error && <span> Error: {error}</span>}
    </div>
  );
}

function Breadcrumb({ path, onNavigate }) {
  const segments = path ? path.split('/') : [];
  return (
    <div>
      <button onClick={() => onNavigate('')}>root</button>
      {segments.map((seg, i) => (
        <span key={i}>
          {' / '}
          <button onClick={() => onNavigate(segments.slice(0, i + 1).join('/'))}>
            {seg}
          </button>
        </span>
      ))}
    </div>
  );
}

function FileTree({ items, currentPath, loading, error, onNavigate, onSelectFile }) {
  if (loading) return <p>Loading folder...</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!items.length) return <p>(empty folder)</p>;

  return (
    <ul>
      {items.map(item => (
        <li key={item.name}>
          <button onClick={() => item.type === 'folder'
            ? onNavigate(currentPath ? `${currentPath}/${item.name}` : item.name)
            : onSelectFile(currentPath ? `${currentPath}/${item.name}` : item.name)
          }>
            {item.type === 'folder' ? '📁' : '📄'} {item.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

function FilePanel({ filePath, data, loading, error }) {
  if (!filePath) return <p>Select a file to read it.</p>;
  if (loading) return <p>Loading file...</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!data) return null;

  const { content, encoding, metadata } = data;
  const flashcards = metadata?.flashcards ?? [];

  return (
    <div>
      <p><strong>Path:</strong> {filePath}</p>
      <p><strong>Encoding:</strong> {encoding}</p>
      <p><strong>Tags:</strong> {metadata?.tags?.join(', ') || 'none'}</p>
      <p><strong>Flashcards:</strong> {flashcards.length}</p>

      {flashcards.length > 0 && (
        <details>
          <summary>Flashcards ({flashcards.length})</summary>
          <ul>
            {flashcards.map(fc => (
              <li key={fc.globalHash}>
                [{fc.category ?? 'uncategorized'}] {fc.vanillaData?.frontText ?? fc.name ?? fc.globalHash}
                {' — level '}{fc.level ?? 0}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details>
        <summary>Raw content</summary>
        <pre>{content?.slice(0, 1000)}{content?.length > 1000 ? '\n...(truncated)' : ''}</pre>
      </details>
    </div>
  );
}

export default function DocumentsView() {
  const [folderPath, setFolderPath] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);

  const folder = useFolderContents(folderPath);
  const file = useFileContents(selectedFile);

  const handleNavigate = (path) => {
    setFolderPath(path);
    setSelectedFile(null);
  };

  return (
    <div>
      <h2>Documents</h2>
      <Breadcrumb path={folderPath} onNavigate={handleNavigate} />
      <CreateBar currentPath={folderPath} onCreated={folder.refresh} />
      <FileTree
        items={folder.items}
        currentPath={folderPath}
        loading={folder.loading}
        error={folder.error}
        onNavigate={handleNavigate}
        onSelectFile={setSelectedFile}
      />
      <hr />
      <FilePanel
        filePath={selectedFile}
        data={file.data}
        loading={file.loading}
        error={file.error}
      />
    </div>
  );
}
