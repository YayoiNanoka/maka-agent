import { z } from 'zod';
import type {
  PlanExecution,
  PlanMutationResult,
  PlanProposal,
  PlanStepStatus,
  PlanStore,
} from '@maka/core/plan';

import type { MakaTool } from './tool-runtime.js';

const MARKDOWN_PATTERN =
  /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|!?(?:\[[^\]\n]+\]\([^)\n]+\))|(?:\*\*|__|`)/;

const plainTextSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !MARKDOWN_PATTERN.test(value), {
      message: `${label} must be plain text without Markdown formatting`,
    });

const stepDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: plainTextSchema('Plan step title').max(30),
  description: plainTextSchema('Plan step description'),
  files: z.array(z.string().min(1)).optional(),
  complexity: z.enum(['low', 'medium', 'high']).optional(),
});

const executionStepSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  note: z.string().min(1).optional(),
});

export type PlanToolResult =
  | {
      kind: 'plan_submitted';
      proposal: PlanProposal;
      storeVersion: number;
    }
  | {
      kind:
        | 'plan_execution_started'
        | 'plan_execution_resumed'
        | 'plan_progress_updated'
        | 'plan_execution_completed';
      execution: PlanExecution;
      storeVersion: number;
    }
  | {
      kind: 'plan_execution_cancelled';
      execution: PlanExecution;
      storeVersion: number;
    };

export function buildSubmitPlanTool(
  planStore: PlanStore,
  sourceExecutionId?: string,
): MakaTool<
  {
    title: string;
    overview?: string;
    steps: Array<{
      id: string;
      title: string;
      description: string;
      files?: string[];
      complexity?: 'low' | 'medium' | 'high';
    }>;
    risks?: string[];
  },
  PlanToolResult
> {
  return {
    name: 'SubmitPlan',
    description:
      'Submit the finished implementation plan for user approval. Every step requires a concise plain-text title and a detailed plain-text description; do not use Markdown in either field. This ends the planning turn, so do not call it until the plan is ready to review.',
    parameters: z.object({
      title: z.string().min(1),
      overview: z.string().min(1).optional(),
      steps: z.array(stepDefinitionSchema).min(1).max(50),
      risks: z.array(z.string().min(1)).max(20).optional(),
    }),
    permissionRequired: false,
    impl: async (input, context) => {
      const result = await planStore.submitProposal({
        sessionId: context.sessionId,
        turnId: context.turnId,
        ...(sourceExecutionId ? { sourceExecutionId } : {}),
        ...input,
      });
      return {
        kind: 'plan_submitted',
        proposal: result.state.proposals.find(
          (proposal) => proposal.proposalId === result.state.latestProposalId,
        )!,
        storeVersion: result.state.storeVersion,
      };
    },
  };
}

export function buildUpdatePlanTool(planStore: PlanStore): MakaTool<
  {
    title: string;
    overview?: string;
    executionStatus?: 'active' | 'cancelled';
    steps: Array<{
      id: string;
      title: string;
      description: string;
      status: PlanStepStatus;
      note?: string;
      files?: string[];
      complexity?: 'low' | 'medium' | 'high';
    }>;
    explanation?: string;
  },
  PlanToolResult
> {
  return {
    name: 'update_plan',
    description:
      "Start or update the main Agent's current internal execution plan for complex work expected to finish in the current turn. You must call this tool after initial reconnaissance and before the first mutating tool call when the task has three or more dependent stages, spans multiple components, requires investigation followed by implementation or verification, or has intermediate results that determine later work. Repository-wide audits or refactors, multi-file implementations, debugging followed by fixes and tests, and build or installation work followed by verification qualify; for them this tool is a mandatory execution gate, not optional bookkeeping. Do not use task_create or task_update as a substitute for these ordered execution steps. Skip simple or single-step work. Submit the complete plan snapshot, keep at most one step in_progress, and continue execution immediately without waiting for user approval.",
    parameters: z.object({
      title: plainTextSchema('Plan title'),
      overview: plainTextSchema('Plan overview').optional(),
      executionStatus: z.enum(['active', 'cancelled']).optional(),
      steps: z
        .array(
          stepDefinitionSchema.extend({
            status: executionStepSchema.shape.status,
            note: executionStepSchema.shape.note,
          }),
        )
        .min(1)
        .max(50),
      explanation: z.string().min(1).optional(),
    }),
    permissionRequired: false,
    impl: async (input, context) => {
      const result = await planStore.applyExecutionSnapshot({
        sessionId: context.sessionId,
        ...input,
      });
      return executionResult(result);
    },
  };
}

export function buildCancelPlanTool(
  planStore: PlanStore,
  executionId: string,
): MakaTool<{ reason: string }, PlanToolResult> {
  return {
    name: 'cancel_plan',
    description:
      'Cancel the active plan execution when the user explicitly asks to abandon it. Explain the user request in reason.',
    parameters: z.object({ reason: z.string().min(1) }),
    permissionRequired: false,
    impl: async ({ reason }, context) => {
      const result = await planStore.cancelExecution({
        sessionId: context.sessionId,
        executionId,
        reason,
      });
      return executionResult(result);
    },
  };
}

function executionResult(result: PlanMutationResult): PlanToolResult {
  const executionId =
    'executionId' in result.event ? result.event.executionId : result.state.activeExecutionId;
  const execution = result.state.executions.find(
    (candidate) => candidate.executionId === executionId,
  );
  if (!execution) throw new Error('Plan execution projection is missing');
  if (result.event.type === 'plan_execution_started') {
    return { kind: 'plan_execution_started', execution, storeVersion: result.state.storeVersion };
  }
  if (result.event.type === 'plan_execution_resumed') {
    return { kind: 'plan_execution_resumed', execution, storeVersion: result.state.storeVersion };
  }
  if (result.event.type === 'plan_execution_completed') {
    return { kind: 'plan_execution_completed', execution, storeVersion: result.state.storeVersion };
  }
  if (result.event.type === 'plan_execution_cancelled') {
    return { kind: 'plan_execution_cancelled', execution, storeVersion: result.state.storeVersion };
  }
  return { kind: 'plan_progress_updated', execution, storeVersion: result.state.storeVersion };
}
