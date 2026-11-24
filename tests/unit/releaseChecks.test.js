import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prereleasePassed } from '../../scripts/releaseChecks.js';

describe('prereleasePassed', () => {
    const sha = 'abc123';

    it('accepts a successful run of the exact commit', () => {
        assert.equal(prereleasePassed([{ headSha: sha, conclusion: 'success' }], sha), true);
    });

    it('refuses a failed, cancelled or still-running run of that commit', () => {
        for (const conclusion of ['failure', 'cancelled', '', null]) {
            assert.equal(prereleasePassed([{ headSha: sha, conclusion }], sha), false, String(conclusion));
        }
    });

    it('refuses a success that tested another commit', () => {
        assert.equal(prereleasePassed([{ headSha: 'older', conclusion: 'success' }], sha), false);
    });

    it('refuses when GitHub returned nothing usable', () => {
        assert.equal(prereleasePassed(null, sha), false);
        assert.equal(prereleasePassed([], sha), false);
    });
});
