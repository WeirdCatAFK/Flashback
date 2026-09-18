/**
 * Importing files into the vault: one upload at a time with progress, packages
 * (.zip, .apkg) through the zip/Anki importer — which may come back asking for a
 * field mapping — and the broadcast that tells every view the vault changed.
 * Used by the file explorer and the Decks view.
 */

import { useState, useCallback } from 'react';
import { importFileWithProgress, importZipWithProgress, applyAnkiMapping } from '../api/documents';
import { invalidateData } from '../utils/dataBus';
import { useT } from '../translations/index';

/** Zips and Anki packages go through the package importer, everything else through the file importer. */
export const isPackage = (fileName) => /\.(zip|apkg)$/i.test(fileName);

export default function useImports() {
  const { t } = useT();
  const [importing, setImporting] = useState(null);
  const [ankiMapping, setAnkiMapping] = useState(null);
  const [ankiBusy, setAnkiBusy] = useState(false);
  const [ankiError, setAnkiError] = useState(null);
  const [error, setError] = useState(null);

  const importFiles = useCallback(async (files, parent = '') => {
    if (!files || !files.length) return;
    setError(null);
    let current = null;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        current = file.name;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('name', file.name);
        const report = (pct) => setImporting({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name });
        if (isPackage(file.name)) {
          fd.append('targetPath', parent);
          const result = await importZipWithProgress(fd, report);
          if (result?.needsMapping) {
            setAnkiMapping({ report: result, filename: file.name });
            continue;
          }
        } else {
          fd.append('parentPath', parent);
          await importFileWithProgress(fd, report);
        }
        setImporting({ done: i + 1, total: files.length, pct: 0, processing: false, filename: file.name });
      }
      invalidateData();
    } catch (err) {
      console.error('Import failed', err);
      setError({ message: err?.message, filename: current });
    } finally {
      setImporting(null);
    }
  }, []);

  const applyMapping = useCallback(async (mappings) => {
    setAnkiBusy(true);
    setAnkiError(null);
    try {
      await applyAnkiMapping(ankiMapping.report.sessionId, mappings);
      setAnkiMapping(null);
      invalidateData();
    } catch (err) {
      console.error('Anki import failed', err);
      setAnkiError(err.message || t('The import failed. Pick the file again to retry.'));
    } finally {
      setAnkiBusy(false);
    }
  }, [ankiMapping, t]);

  return {
    importing, ankiMapping, ankiBusy, ankiError, error, importFiles, applyMapping,
    clearError: () => setError(null),
    cancelMapping: () => { setAnkiMapping(null); setAnkiError(null); },
  };
}
