import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryExtractionSessionLane } from '../server/memory-extraction-session-lane.js';

test('user-requested extraction passes queued background work without preempting the running job', async () => {
  const lane = new MemoryExtractionSessionLane();
  const order: string[] = [];
  let releaseRunning!: () => void;
  const runningGate = new Promise<void>((resolve) => {
    releaseRunning = resolve;
  });

  const running = lane.run(
    'session-1',
    async () => {
      order.push('background-running');
      await runningGate;
    },
    'background',
  );
  const queued = lane.run(
    'session-1',
    async () => {
      order.push('background-queued');
    },
    'background',
  );
  const foreground = lane.run(
    'session-1',
    async () => {
      order.push('foreground');
    },
    'foreground',
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['background-running']);
  releaseRunning();
  await Promise.all([running, queued, foreground]);
  assert.deepEqual(order, ['background-running', 'foreground', 'background-queued']);
});
