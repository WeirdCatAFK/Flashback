import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { triesLeft } from '../../src/ui/utils/sessionContext.js';

describe('the identity request', () => {
  test('waits for a server that does not answer yet, however long it takes to start', () => {
    assert.equal(triesLeft(new TypeError('Failed to fetch'), 0), 0);
    assert.equal(triesLeft(new TypeError('Failed to fetch'), 5), 5);
    assert.equal(triesLeft(Object.assign(new Error('switching'), { status: 503 }), 0), 0);
  });
  test('gives up on a server that keeps answering with an error', () => {
    const broken = Object.assign(new Error('boom'), { status: 500 });
    assert.equal(triesLeft(broken, 2), 1);
    assert.equal(triesLeft(broken, 0), null);
  });
  test('never asks again after a refusal', () => {
    assert.equal(triesLeft(Object.assign(new Error('Unauthorized'), { status: 401 }), 5), null);
  });
});
