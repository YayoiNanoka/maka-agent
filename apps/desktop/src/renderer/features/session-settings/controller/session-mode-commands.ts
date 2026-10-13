/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { SessionSummary } from '@maka/core/session';
import type { NewTaskSettings, SessionSettingValues } from '../model/session-settings-contract.js';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SessionSettingsCommands } from '../model/session-settings-contract.js';

/** The composer menu and slash commands share the same selected/new task rules. */
export function createSessionModeCommands(input: {
  sessionId(): string | undefined;
  planMode(): boolean;
  orchestrationMode(): OrchestrationMode;
  commands: SessionSettingsCommands;
}) {
  const setPlanMode = (active: boolean): Promise<boolean> => {
    const sessionId = input.sessionId();
    if (!sessionId) { input.commands.setNewTaskPlanMode(active); return Promise.resolve(true); }
    if (active === input.planMode()) return Promise.resolve(true);
    return input.commands.setPlanMode(sessionId, active);
  };
  const setOrchestrationMode = (mode: OrchestrationMode): Promise<boolean> => {
    const sessionId = input.sessionId();
    if (!sessionId) { input.commands.setNewTaskOrchestrationMode(mode); return Promise.resolve(true); }
    if (mode === input.orchestrationMode()) return Promise.resolve(true);
    return input.commands.setOrchestrationMode(sessionId, mode);
  };
  const setOrchestrationModeActive = (mode: Exclude<OrchestrationMode, 'default'>, active: boolean): Promise<boolean> => {
    if (active) return setOrchestrationMode(mode);
    if (input.orchestrationMode() !== mode) return Promise.resolve(true);
    return setOrchestrationMode('default');
  };
  return { setPlanMode, setOrchestrationMode, setOrchestrationModeActive };
}

/** Optimistic settings and the pending first-send defaults have one presentation. */
export function deriveSessionSettingsPresentation<T extends SessionSummary>(
  session: T | undefined,
  sessionId: string | undefined,
  intent: { overlay: Partial<SessionSettingValues>; newTask: NewTaskSettings },
) {
  const model = intent.overlay.modelConfiguration;
  return {
    activeSessionForModelControls: session && {
      ...session,
      ...(model ? {
        llmConnectionId: model.modelTarget.llmConnectionId,
        llmConnectionSlug: model.modelTarget.llmConnectionSlug,
        model: model.modelTarget.model,
        thinkingLevel: model.thinkingLevel ?? undefined,
      } : {}),
    },
    activePlanMode: sessionId
      ? intent.overlay.planMode ?? ((session?.collaborationMode ?? 'agent') === 'plan')
      : intent.newTask.planMode,
    activeOrchestrationMode: sessionId
      ? intent.overlay.orchestrationMode ?? session?.orchestrationMode ?? 'default'
      : intent.newTask.orchestrationMode,
  };
}
