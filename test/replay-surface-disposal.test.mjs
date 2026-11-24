import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MessageProcessor} from '@a2ui/web_core/v0_9';
import {replayV09, replayV09Actions, replayV09Recoverable} from '../src/replay.mjs';

const createSurface = {
  version: 'v0.9',
  createSurface: {surfaceId: 'held-open', catalogId: '__BASIC_CATALOG__'},
};

test('headless replays dispose live surfaces on success and input failure', async () => {
  const originalDispose = MessageProcessor.prototype.dispose;
  const observed = [];
  // Inspect the real published SDK processor at its existing dispose boundary.
  MessageProcessor.prototype.dispose = function (...args) {
    observed.push({
      surfaces: this.model.surfacesMap.size,
      actionSubscriptions: this.model.surfaceUnsubscribers.size,
      errorSubscriptions: this.model.surfaceErrorUnsubscribers.size,
    });
    return originalDispose.apply(this, args);
  };
  try {
    assert.equal(replayV09([createSurface]).snapshots[0].exists, true);
    assert.throws(() => replayV09([createSurface, {notCloneable: () => {}}]), /clone/i);
    assert.equal((await replayV09Actions([{message: createSurface}])).snapshots[0].exists, true);
    assert.equal(replayV09Recoverable([createSurface]).events[0].outcome, 'applied');
    const clean = {surfaces: 0, actionSubscriptions: 0, errorSubscriptions: 0};
    assert.deepEqual(observed, [clean, clean, clean, clean]);
  } finally {
    MessageProcessor.prototype.dispose = originalDispose;
  }
});
