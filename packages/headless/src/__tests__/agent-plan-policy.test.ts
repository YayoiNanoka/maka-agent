import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createPlanStore } from '@maka/storage';
import {
  HEADLESS_AGENT_PLAN_POLICY_VERSION,
  appendHeadlessAgentPlanPolicyToSystemPrompt,
  renderHeadlessAgentPlanReplay,
  resolveHeadlessAgentPlanPolicy,
} from '../agent-plan-policy.js';

describe('Headless autonomous Plan policy', () => {
  test('defaults off and parses the benchmark context flag strictly', () => {
    assert.deepEqual(resolveHeadlessAgentPlanPolicy({}), {
      enabled: false,
      policyVersion: HEADLESS_AGENT_PLAN_POLICY_VERSION,
    });
    assert.equal(resolveHeadlessAgentPlanPolicy({ MAKA_CONTEXT_AGENT_PLAN: 'on' }).enabled, true);
    assert.equal(resolveHeadlessAgentPlanPolicy({ MAKA_CONTEXT_AGENT_PLAN: 'off' }).enabled, false);
    assert.throws(
      () => resolveHeadlessAgentPlanPolicy({ MAKA_CONTEXT_AGENT_PLAN: 'sometimes' }),
      /MAKA_CONTEXT_AGENT_PLAN must be a boolean/,
    );
  });

  test('appends the autonomous planning policy only to the enabled arm', () => {
    const base = 'Act with available tools.';
    const disabled = appendHeadlessAgentPlanPolicyToSystemPrompt(
      base,
      resolveHeadlessAgentPlanPolicy({ MAKA_CONTEXT_AGENT_PLAN: 'off' }),
    );
    const enabled = appendHeadlessAgentPlanPolicyToSystemPrompt(
      base,
      resolveHeadlessAgentPlanPolicy({ MAKA_CONTEXT_AGENT_PLAN: 'on' }),
    );

    assert.equal(disabled, base);
    assert.match(enabled, /^Act with available tools\.\n\n<agent_planning>/);
    assert.match(enabled, /continue execution in the same turn/i);
    assert.match(enabled, /update_plan/);
  });

  test('replays active and interrupted agent plans from the durable Plan store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-headless-agent-plan-'));
    try {
      let id = 0;
      const store = createPlanStore(root, {
        now: () => 100 + id,
        newId: () => `id-${++id}`,
      });
      await store.applyExecutionSnapshot({
        sessionId: 'session-1',
        title: 'Inspect repository',
        overview: 'Read and verify without changing files',
        steps: [
          {
            id: 'inspect',
            title: 'Inspect files',
            description: 'Read the relevant source files',
            status: 'completed',
          },
          {
            id: 'verify',
            title: 'Verify findings',
            description: 'Check the evidence and summarize it',
            status: 'in_progress',
          },
        ],
      });

      const activeReplay = await renderHeadlessAgentPlanReplay(store, 'session-1');
      assert.match(activeReplay ?? '', /<agent_plan_context>/);
      assert.match(activeReplay ?? '', /Inspect files/);
      assert.match(activeReplay ?? '', /Continue this internal plan/);

      await store.interruptActiveExecution('session-1', 'turn_stopped');
      const interruptedReplay = await renderHeadlessAgentPlanReplay(store, 'session-1');
      assert.match(interruptedReplay ?? '', /turn_stopped/);
      assert.match(
        interruptedReplay ?? '',
        /decide whether to continue it, revise it and continue, or cancel it/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
