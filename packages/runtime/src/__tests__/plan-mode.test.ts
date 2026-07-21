import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  renderAgentModePlanningPrompt,
  renderAgentPlanExecutionContext,
  renderInterruptedPlanContext,
  renderPlanExecutionPrompt,
  renderPlanModePrompt,
  selectCollaborationTools,
} from '../plan-mode.js';
import { buildSubmitPlanTool, buildUpdatePlanTool } from '../plan-tools.js';
import type { MakaTool } from '../tool-runtime.js';

describe('Plan Mode tool surface', () => {
  test('requires plain-text step titles and descriptions', () => {
    const submitPlan = buildSubmitPlanTool({} as never);
    const schema = submitPlan.parameters as {
      safeParse(input: unknown): { success: boolean };
    };
    const valid = {
      title: 'Plan',
      steps: [{ id: 'inspect', title: 'Inspect code', description: 'Read the relevant files.' }],
    };

    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(
      schema.safeParse({ title: 'Plan', steps: [{ id: 'inspect', description: 'Read files.' }] })
        .success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [{ id: 'inspect', title: '**Inspect code**', description: 'Read files.' }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        title: 'Plan',
        steps: [{ id: 'inspect', title: 'Inspect code', description: '- Read files' }],
      }).success,
      false,
    );
    assert.match(renderPlanModePrompt(), /plain text without Markdown formatting/);
  });

  test('keeps read tools and plan controls while removing writes and subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'plan',
      hasActiveExecution: false,
      tools: [
        tool('Read', 'read'),
        tool('WebSearch', 'web_read'),
        tool('Write', 'file_write'),
        tool('ExploreAgent', 'subagent'),
        tool('AskUserQuestion'),
        tool('SubmitPlan'),
        tool('update_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Read', 'WebSearch', 'AskUserQuestion', 'SubmitPlan'],
    );
  });

  test('active execution exposes progress controls and removes subagents', () => {
    const selected = selectCollaborationTools({
      mode: 'agent',
      hasActiveExecution: true,
      tools: [
        tool('Write', 'file_write'),
        tool('ExploreAgent', 'subagent'),
        tool('SubmitPlan'),
        tool('update_plan'),
        tool('cancel_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Write', 'update_plan', 'cancel_plan'],
    );
  });

  test('requires autonomous planning for complex current-turn work before an execution exists', () => {
    const selected = selectCollaborationTools({
      mode: 'agent',
      hasActiveExecution: false,
      tools: [
        tool('Write', 'file_write'),
        tool('SubmitPlan'),
        tool('update_plan'),
        tool('cancel_plan'),
      ],
    });
    assert.deepEqual(
      selected.map((tool) => tool.name),
      ['Write', 'update_plan'],
    );

    const prompt = renderAgentModePlanningPrompt();
    assert.match(prompt, /three or more dependent stages/);
    assert.match(prompt, /must call update_plan/);
    assert.match(prompt, /before the first mutating tool call/);
    assert.match(prompt, /Repository-wide audits or refactors/);
    assert.match(prompt, /mandatory execution gate/);
    assert.match(prompt, /simple factual questions/);
    assert.doesNotMatch(prompt, /purely informational requests/);
    assert.match(prompt, /Do not use task_create or task_update/);
    assert.match(prompt, /only for durable, independently trackable work/);
    assert.match(prompt, /Never duplicate the same work/);
    assert.match(prompt, /does not require user approval/);
    assert.match(prompt, /Continue execution in the same turn/);
    assert.match(prompt, /Completed and skipped steps are immutable/);

    const updatePlan = buildUpdatePlanTool({} as never);
    assert.match(
      updatePlan.description,
      /Start or update the main Agent's current internal execution plan/,
    );
    assert.match(updatePlan.description, /must call this tool/);
    assert.match(updatePlan.description, /before the first mutating tool call/);
    assert.match(updatePlan.description, /mandatory execution gate/);
    assert.match(updatePlan.description, /three or more dependent stages/);
    assert.match(updatePlan.description, /Do not use task_create or task_update as a substitute/);
    assert.match(updatePlan.description, /without waiting for user approval/);
  });

  test('lets the agent decide how to handle an interrupted internal plan', () => {
    const prompt = renderAgentPlanExecutionContext({
      executionId: 'execution-1',
      planId: 'plan-1',
      source: 'agent_initiated',
      sessionId: 'session-1',
      title: 'Internal implementation plan',
      status: 'interrupted',
      steps: [
        {
          id: 'inspect',
          title: 'Inspect code',
          description: 'Inspect the implementation.',
          status: 'completed',
          updatedAt: 2,
        },
        {
          id: 'change',
          title: 'Change code',
          description: 'Implement the change.',
          status: 'pending',
          updatedAt: 2,
        },
      ],
      startedAt: 1,
      updatedAt: 2,
      interruptedAt: 2,
      interruptionReason: 'turn_aborted',
    });

    assert.match(prompt, /decide whether to continue it, revise it and continue, or cancel it/);
    assert.match(prompt, /executionStatus cancelled/);
    assert.match(prompt, /Do not ask the user to manage the plan through UI controls/);
  });

  test('injects interrupted progress as replanning context without resuming execution', () => {
    const prompt = renderInterruptedPlanContext({
      proposal: {
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        title: 'Original plan',
        steps: [{ id: 'inspect', title: 'Inspect code', description: 'Inspect' }],
        status: 'approved',
        submittedAt: 1,
      },
      execution: {
        executionId: 'execution-1',
        planId: 'plan-1',
        source: 'user_approved',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        title: 'Original plan',
        status: 'interrupted',
        steps: [
          {
            id: 'inspect',
            title: 'Inspect code',
            description: 'Inspect',
            status: 'completed',
            updatedAt: 2,
          },
        ],
        startedAt: 1,
        updatedAt: 2,
        interruptedAt: 2,
        interruptionReason: 'User stopped execution',
      },
    });

    assert.match(prompt, /Interrupted execution ID: execution-1/);
    assert.match(prompt, /<title>Inspect code<\/title>/);
    assert.match(prompt, /<description>Inspect<\/description>/);
    assert.match(prompt, /<status>completed<\/status>/);
    assert.match(prompt, /Do not resume execution or modify files/);
  });

  test('requires execution progress updates at step boundaries', () => {
    const prompt = renderPlanExecutionPrompt({
      proposal: {
        planId: 'plan-1',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        title: 'Implement plan',
        steps: [{ id: 'change', title: 'Change implementation', description: 'Change code' }],
        status: 'approved',
        submittedAt: 1,
      },
      execution: {
        executionId: 'execution-1',
        planId: 'plan-1',
        source: 'user_approved',
        proposalId: 'proposal-1',
        sessionId: 'session-1',
        title: 'Implement plan',
        status: 'active',
        steps: [
          {
            id: 'change',
            title: 'Change implementation',
            description: 'Change code',
            status: 'pending',
            updatedAt: 1,
          },
        ],
        startedAt: 1,
        updatedAt: 1,
      },
    });

    assert.match(prompt, /Before implementation, call update_plan/);
    assert.match(prompt, /<title>Change implementation<\/title>/);
    assert.match(prompt, /<description>Change code<\/description>/);
    assert.match(prompt, /Immediately after finishing a step, call update_plan again/);
    assert.match(prompt, /Before the final response, update every finished or skipped step/);
  });
});

function tool(name: string, categoryHint?: MakaTool['categoryHint']): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    ...(categoryHint ? { categoryHint } : {}),
    impl: () => null,
  };
}
