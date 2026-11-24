import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTextAndContext, listOf } from '../../src/api/access/modules/highlightText.js';

describe('resolveTextAndContext', () => {
    const body = 'The mitochondria is the powerhouse of the cell.';

    it('uses the offsets when they still fit the body', () => {
        const { text, context } = resolveTextAndContext({ start: 4, end: 16 }, body);
        assert.equal(text, 'mitochondria');
        assert.equal(context, body);
    });

    it('finds the stored text when the offsets no longer fit', () => {
        const { text, context } = resolveTextAndContext({ text: 'powerhouse', start: 900, end: 910 }, body);
        assert.equal(text, 'powerhouse');
        assert.ok(context.includes('powerhouse'));
    });

    it('keeps the stored text without context when the body lost it', () => {
        assert.deepEqual(resolveTextAndContext({ text: 'ribosome' }, body), { text: 'ribosome', context: null });
    });

    it('ignores offsets on a highlight that is not a text offset', () => {
        assert.deepEqual(resolveTextAndContext({ type: 'pdf_box', start: 0, end: 3 }, body), { text: null, context: null });
    });

    it('marks a cut context with ellipses', () => {
        const long = `${'a'.repeat(300)}TARGET${'b'.repeat(300)}`;
        const { context } = resolveTextAndContext({ text: 'TARGET' }, long);
        assert.ok(context.startsWith('…') && context.endsWith('…'));
        assert.equal(context.length, 200 + 'TARGET'.length + 200 + 2);
    });

    it('works without a body, as for a PDF', () => {
        assert.deepEqual(resolveTextAndContext({ text: 'x' }, null), { text: 'x', context: null });
    });
});

describe('listOf', () => {
    it('passes an array through and turns anything else into an empty list', () => {
        assert.deepEqual(listOf([1]), [1]);
        for (const bad of [undefined, null, 'oops', 5, {}]) assert.deepEqual(listOf(bad), []);
    });
});
