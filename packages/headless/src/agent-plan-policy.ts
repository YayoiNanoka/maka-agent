import { activePlanExecution, type PlanExecution, type PlanSessionState } from '@maka/core/plan';
import { renderAgentModePlanningPrompt, renderAgentPlanExecutionContext } from '@maka/runtime';
import type { PlanStore } from '@maka/core/plan';
import { booleanEnv, type RunHarborCellEnv } from './headless-run-env.js';

export const HEADLESS_AGENT_PLAN_POLICY_VERSION = 'maka-headless-agent-plan.v1';

export interface HeadlessAgentPlanPolicy {
  enabled: boolean;
  policyVersion: typeof HEADLESS_AGENT_PLAN_POLICY_VERSION;
}

export function resolveHeadlessAgentPlanPolicy(
  env: RunHarborCellEnv = process.env,
): HeadlessAgentPlanPolicy {
  return {
    enabled: booleanEnv(env.MAKA_CONTEXT_AGENT_PLAN, 'MAKA_CONTEXT_AGENT_PLAN') ?? false,
    policyVersion: HEADLESS_AGENT_PLAN_POLICY_VERSION,
  };
}

export function appendHeadlessAgentPlanPolicyToSystemPrompt(
  systemPrompt: string,
  policy: HeadlessAgentPlanPolicy,
): string {
  if (!policy.enabled) return systemPrompt;
  return `${systemPrompt}\n\n${renderAgentModePlanningPrompt()}`;
}

export async function renderHeadlessAgentPlanReplay(
  planStore: PlanStore,
  sessionId: string,
): Promise<string | undefined> {
  const state = await planStore.readState(sessionId);
  const execution =
    activePlanExecution(state) ??
    [...state.executions]
      .reverse()
      .find(
        (candidate) => candidate.source === 'agent_initiated' && candidate.status === 'interrupted',
      );
  return execution ? renderAgentPlanExecutionContext(execution) : undefined;
}

export function latestHeadlessAgentPlanExecution(
  state: PlanSessionState,
): PlanExecution | undefined {
  return [...state.executions]
    .reverse()
    .find((execution) => execution.source === 'agent_initiated');
}
