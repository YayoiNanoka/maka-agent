import { classifyToolUse } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { PlanExecution, PlanProposal } from '@maka/core/plan';

import type { MakaTool } from './tool-runtime.js';

const PLAN_CONTROL_TOOLS = new Set(['SubmitPlan', 'update_plan', 'cancel_plan']);

export function selectCollaborationTools(input: {
  mode: CollaborationMode;
  tools: readonly MakaTool[];
  hasActiveExecution: boolean;
}): MakaTool[] {
  if (input.mode === 'plan') {
    return input.tools.filter((tool) => {
      if (tool.name === 'SubmitPlan' || tool.name === 'AskUserQuestion') return true;
      if (PLAN_CONTROL_TOOLS.has(tool.name)) return false;
      const category = classifyToolUse({
        toolName: tool.name,
        args: {},
        ...(tool.categoryHint ? { categoryHint: tool.categoryHint } : {}),
      });
      return category === 'read' || category === 'web_read';
    });
  }

  return input.tools.filter((tool) => {
    if (tool.name === 'SubmitPlan') return false;
    if (tool.categoryHint === 'subagent' && input.hasActiveExecution) return false;
    if (tool.name === 'update_plan') return true;
    if (tool.name === 'cancel_plan') return input.hasActiveExecution;
    return true;
  });
}

export function renderAgentModePlanningPrompt(): string {
  return [
    '<agent_planning>',
    'For work expected to finish in the current turn, use update_plan after initial reconnaissance and before broad execution when the task has three or more dependent stages, spans multiple components, requires investigation followed by implementation or verification, or has intermediate results that determine later work.',
    'Do not create a plan for simple factual questions, single-step work, or requests that require no multi-stage investigation.',
    'Do not use task_create or task_update to represent the ordered execution steps of the current request. The Task Ledger is only for durable, independently trackable work that must remain visible across turns or agents. Never duplicate the same work as both Plan steps and Task Ledger tasks.',
    'Before the first update_plan call, privately review that the plan is complete, ordered, feasible, and no more detailed than necessary. A new agent-initiated plan must contain at least two steps.',
    'Creating a plan does not change Collaboration Mode and does not require user approval. Continue execution in the same turn immediately after creating it.',
    'Submit the complete plan snapshot on every update. Keep at most one step in_progress, update progress promptly after completing work, and make every finished or skipped step terminal before the final response.',
    'You may revise pending work while executing. Never delete a step: mark unnecessary work skipped. Completed and skipped steps are immutable.',
    'Treat the plan as internal execution state, not as the response deliverable. Do not ask the user to manage it through UI controls.',
    '</agent_planning>',
  ].join('\n');
}

export function renderPlanModePrompt(): string {
  return [
    '<collaboration_mode>',
    '# Collaboration Mode: Plan',
    'You are planning only. Inspect the repository and discuss tradeoffs, but do not modify files or perform side effects.',
    'Use AskUserQuestion only when a bounded answer is required. Subagents are unavailable in this mode.',
    'When the plan is ready for approval, call SubmitPlan exactly once with a concise title, overview, ordered steps, and material risks.',
    'Every step must have a short title (30 characters or fewer) and a detailed description. Both fields must be plain text without Markdown formatting.',
    'Do not claim that implementation has started or completed.',
    '</collaboration_mode>',
  ].join('\n');
}

export function renderInterruptedPlanContext(input: {
  proposal: PlanProposal;
  execution: PlanExecution;
}): string {
  const steps = input.execution.steps.map((step) => renderExecutionStep(step)).join('\n');
  return [
    '<interrupted_plan_context>',
    `Plan: ${input.proposal.title}`,
    `Plan ID: ${input.proposal.planId}`,
    `Proposal: ${input.proposal.proposalId} (revision ${input.proposal.revision})`,
    `Interrupted execution ID: ${input.execution.executionId}`,
    input.execution.interruptionReason
      ? `Interruption reason: ${input.execution.interruptionReason}`
      : '',
    'Progress at interruption:',
    steps,
    'The user entered Plan Mode to replan the remaining work. Do not resume execution or modify files. A submitted proposal will supersede this interrupted execution when approved.',
    '</interrupted_plan_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderPlanExecutionPrompt(input: {
  proposal: PlanProposal;
  execution: PlanExecution;
}): string {
  const steps = input.execution.steps.map((step) => renderExecutionStep(step)).join('\n');
  return [
    '<plan_execution_context>',
    `Plan: ${input.proposal.title}`,
    `Plan ID: ${input.proposal.planId}`,
    `Proposal: ${input.proposal.proposalId} (revision ${input.proposal.revision})`,
    `Execution ID: ${input.execution.executionId}`,
    input.proposal.overview ? `Overview: ${input.proposal.overview}` : '',
    'Approved steps:',
    steps,
    'Execute this approved plan. Before implementation, call update_plan with the plan title, overview, and the complete approved step definitions and statuses; set the first actionable step in_progress and leave every other step at its current status. The approved title, overview, step order, titles, and descriptions are immutable. Immediately after finishing a step, call update_plan again to mark it completed and move the next step to in_progress. Before the final response, update every finished or skipped step so the execution can close. If the user explicitly abandons the plan, call cancel_plan. Do not delegate to subagents while this execution is active.',
    '</plan_execution_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderAgentPlanExecutionContext(execution: PlanExecution): string {
  const steps = execution.steps.map((step) => renderExecutionStep(step)).join('\n');
  const interrupted = execution.status === 'interrupted';
  return [
    '<agent_plan_context>',
    `Plan: ${execution.title}`,
    `Plan ID: ${execution.planId}`,
    `Execution ID: ${execution.executionId}`,
    execution.overview ? `Overview: ${execution.overview}` : '',
    interrupted && execution.interruptionReason
      ? `Interruption reason: ${execution.interruptionReason}`
      : '',
    'Current steps:',
    steps,
    interrupted
      ? 'This internal plan was interrupted in the previous turn. Use the latest user message to decide whether to continue it, revise it and continue, or cancel it with update_plan executionStatus cancelled. Do not ask the user to manage the plan through UI controls.'
      : 'Continue this internal plan. Update the complete snapshot as work progresses, revise pending work when necessary, and complete or skip every remaining step before the final response.',
    '</agent_plan_context>',
  ]
    .filter(Boolean)
    .join('\n');
}

function statusMark(status: PlanExecution['steps'][number]['status']): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '>';
  if (status === 'skipped') return '-';
  return ' ';
}

function renderExecutionStep(step: PlanExecution['steps'][number]): string {
  return [
    '<step>',
    `<id>${escapeXml(step.id)}</id>`,
    `<title>${escapeXml(step.title)}</title>`,
    `<description>${escapeXml(step.description)}</description>`,
    `<status>${step.status}</status>`,
    '</step>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
