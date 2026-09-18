/**
 * Translated labels for node types and relations. Switches of literals rather
 * than lookup tables, because the extractor only sees literal t() arguments.
 */

import { useCallback } from 'react';
import { useT } from '../../translations/index';

export default function useGraphLabels() {
  const { t } = useT();

  const typeLabel = useCallback((type) => {
    switch (type) {
      case 'Document': return t('Document');
      case 'Folder': return t('Folder');
      case 'Flashcard': return t('Flashcard');
      case 'Tag': return t('Tag');
      case 'Deck': return t('Deck');
      default: return type;
    }
  }, [t]);

  const relationLabel = useCallback((selectedType, neighborType, relation, direction) => {
    if (relation === 'deck') return direction === 'out' ? t('in deck') : t('deck');
    if (relation === 'tag') return direction === 'out' ? t('tagged') : t('tag for');
    if (relation === 'reference') return direction === 'in' ? t('flashcards') : t('source');
    if (relation === 'inheritance') {
      if (selectedType === 'Folder' && neighborType === 'Folder') return t('subfolders');
      if (selectedType === 'Folder' && neighborType === 'Document') return t('documents');
      if (neighborType === 'Folder') return t('parent');
      if (neighborType === 'Document') return t('source doc');
      return direction === 'out' ? t('children') : t('parent');
    }
    if (relation === 'connection') return t('connected');
    return typeLabel(neighborType);
  }, [t, typeLabel]);

  return { typeLabel, relationLabel };
}
