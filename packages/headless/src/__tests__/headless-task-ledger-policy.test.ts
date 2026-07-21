import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createTaskLedgerStore } from '@maka/storage';
import {
  HEADLESS_TASK_LEDGER_POLICY_VERSION,
  appendHeadlessTaskLedgerPolicyToSystemPrompt,
  renderHeadlessTaskLedgerReplay,
  resolveHeadlessTaskLedgerPolicy,
} from '../headless-task-ledger-policy.js';

describe('Headless Task Ledger policy', () => {
  test('defaults off and parses its context flag strictly', () => {
    assert.deepEqual(resolveHeadlessTaskLedgerPolicy({}), {
      enabled: false,
      policyVersion: HEADLESS_TASK_LEDGER_POLICY_VERSION,
    });
    assert.equal(resolveHeadlessTaskLedgerPolicy({ MAKA_CONTEXT_TASK_LEDGER: 'on' }).enabled, true);
    assert.throws(
      () => resolveHeadlessTaskLedgerPolicy({ MAKA_CONTEXT_TASK_LEDGER: 'maybe' }),
      /MAKA_CONTEXT_TASK_LEDGER must be a boolean/,
    );
  });

  test('adds true Task Ledger guidance only to the enabled arm', () => {
    const base = 'Act with available tools.';
    assert.equal(
      appendHeadlessTaskLedgerPolicyToSystemPrompt(
        base,
        resolveHeadlessTaskLedgerPolicy({ MAKA_CONTEXT_TASK_LEDGER: 'off' }),
      ),
      base,
    );
    const enabled = appendHeadlessTaskLedgerPolicyToSystemPrompt(
      base,
      resolveHeadlessTaskLedgerPolicy({ MAKA_CONTEXT_TASK_LEDGER: 'on' }),
    );
    assert.match(enabled, /task_create, task_update, task_list, and task_get/);
    assert.match(enabled, /never duplicate the same work in both systems/);
  });

  test('renders durable ledger state for the next model step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-headless-task-ledger-'));
    try {
      const store = createTaskLedgerStore(root);
      await store.create('session-1', [{ subject: 'Inspect durable artifacts' }]);
      const replay = await renderHeadlessTaskLedgerReplay(store, 'session-1');
      assert.match(replay ?? '', /<task_ledger>/);
      assert.match(replay ?? '', /Inspect durable artifacts/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
