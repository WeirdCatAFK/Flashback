/**
 * Inline renaming of a tree node: the draft, the commit (with the reserved-name
 * check and the extension rule for files), and the Enter/Escape keys.
 */

import { useState } from 'react';
import { renameItem } from '../../../api/documents';
import { useT } from '../../../translations/index';
import { sanitizeName, reservedNameError, renamedFileName, renamedPath } from './names.js';

export default function useRename({ name, path, isFolder, relocatePaths, onRenamed }) {
  const { t } = useT();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const cancel = () => { setDraft(name); setRenaming(false); };

  const commit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { cancel(); return; }
    const newName = isFolder ? trimmed : renamedFileName(name, trimmed);
    const err = reservedNameError(newName, isFolder ? 'folder' : 'file', t);
    if (err) { window.alert(err); cancel(); return; }
    try {
      await renameItem(path, newName, isFolder);
      relocatePaths?.(path, renamedPath(path, name, newName));
      onRenamed();
    } catch {
      setDraft(name);
    }
    setRenaming(false);
  };

  return {
    renaming,
    start: () => { setDraft(name); setRenaming(true); },
    inputProps: {
      value: draft,
      onChange: (e) => setDraft(sanitizeName(e.target.value)),
      onKeyDown: (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); },
      onBlur: commit,
      onClick: (e) => e.stopPropagation(),
    },
  };
}
