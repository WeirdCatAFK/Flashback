/**
 * Commit actions are stable identifiers in the seal log but labels on screen. A
 * switch of literals rather than a lookup table: the extractor only sees literal
 * t() arguments.
 */

import { useCallback } from 'react';
import { useT } from '../../translations/index';

export default function useActionLabel() {
    const { t } = useT();
    return useCallback((action) => {
        switch (action) {
            case 'create':    return t('Created');
            case 'edit':      return t('Edited');
            case 'metadata':  return t('Metadata');
            case 'move':      return t('Moved');
            case 'delete':    return t('Deleted');
            case 'reconcile': return t('Reconciled');
            default:          return action;
        }
    }, [t]);
}
