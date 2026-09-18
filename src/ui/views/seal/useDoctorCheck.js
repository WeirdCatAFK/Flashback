/**
 * The Vault Doctor's index check — button-triggered rather than automatic,
 * because it walks every file on disk.
 */

import { useState, useCallback } from 'react';
import { checkIndex } from '../../api/doctor';
import { useT } from '../../translations/index';

export default function useDoctorCheck() {
    const { t } = useT();
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const run = useCallback(() => {
        setLoading(true);
        setError(null);
        return checkIndex()
            .then(r => { setReport(r); return r; })
            .catch(err => { setError(err.message ?? t('Check failed')); throw err; })
            .finally(() => setLoading(false));
    }, [t]);

    return { report, loading, error, run, setReport };
}
