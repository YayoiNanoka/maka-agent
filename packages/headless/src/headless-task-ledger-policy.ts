import { renderTaskLedgerPromptText, type TaskLedgerStore } from '@maka/core';
import { booleanEnv, type RunHarborCellEnv } from './headless-run-env.js';

export const HEADLESS_TASK_LEDGER_POLICY_VERSION = 'maka-headless-task-ledger.v1';

export interface HeadlessTaskLedgerPolicy {
  enabled: boolean;
  policyVersion: typeof HEADLESS_TASK_LEDGER_POLICY_VERSION;
}

export function resolveHeadlessTaskLedgerPolicy(
  env: RunHarborCellEnv = process.env,
): HeadlessTaskLedgerPolicy {
  return {
    enabled: booleanEnv(env.MAKA_CONTEXT_TASK_LEDGER, 'MAKA_CONTEXT_TASK_LEDGER') ?? false,
    policyVersion: HEADLESS_TASK_LEDGER_POLICY_VERSION,
  };
}

export function appendHeadlessTaskLedgerPolicyToSystemPrompt(
  systemPrompt: string,
  policy: HeadlessTaskLedgerPolicy,
): string {
  if (!policy.enabled) return systemPrompt;
  return [
    systemPrompt,
    '<task_ledger_policy>',
    'Use task_create, task_update, task_list, and task_get for durable, independently trackable work items when complex work has components that benefit from explicit ownership or must remain recoverable across turns.',
    'Do not use the Task Ledger as an ordered current-turn execution plan. Use update_plan for ordered execution steps, and never duplicate the same work in both systems.',
    'Keep task statuses current. A completed, failed, blocked, or cancelled task requires concise evidence or a reason.',
    '</task_ledger_policy>',
  ].join('\n');
}

export async function renderHeadlessTaskLedgerReplay(
  store: TaskLedgerStore,
  sessionId: string,
): Promise<string | undefined> {
  const tasks = await store.list(sessionId);
  if (tasks.length === 0) return undefined;
  const rendered = renderTaskLedgerPromptText(tasks);
  if (!rendered.text) return undefined;
  return [
    '<task_ledger>',
    rendered.text,
    ...(rendered.omittedCount > 0
      ? [`omitted=${rendered.omittedCount} (use task_list or task_get for the complete ledger)`]
      : []),
    '</task_ledger>',
  ].join('\n');
}
