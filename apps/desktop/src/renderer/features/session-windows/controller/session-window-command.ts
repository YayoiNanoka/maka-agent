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

import type { SessionWindowCommand, SessionWindowCommandResult, SessionWindowNavigation } from '../../../../shared/session-window-contract.js';
import type { SessionWorkspaceSnapshot } from '../../../../shared/session-workspace-state.js';

/** Commands acknowledge only after the editor, resource controls and new view have settled. */
export function createSessionWindowCommandHandler(deps: {
  freeze(value: boolean): void;
  activeSessionId(): string | undefined;
  sessionIds(): readonly string[];
  capture(sessionIds: readonly string[]): Promise<SessionWorkspaceSnapshot>;
  clear(sessionIds: readonly string[], clearSelection: boolean): void;
  restore(snapshot: SessionWorkspaceSnapshot): void;
  navigate(navigation: SessionWindowNavigation, loadSnapshot?: boolean): Promise<void>;
  save(snapshot: SessionWorkspaceSnapshot): Promise<void>;
  detach(sessionIds: readonly string[]): void;
  resume(): void;
}) {
  return async (command: SessionWindowCommand): Promise<SessionWindowCommandResult | undefined> => {
    try {
      switch (command.kind) {
        case 'prepare-transfer':
          deps.freeze(true);
          return { snapshot: await deps.capture(command.group.sessionIds), activeSessionId: deps.activeSessionId() };
        case 'clear':
          deps.clear(command.group.sessionIds, command.group.sessionIds.includes(deps.activeSessionId() ?? ''));
          deps.freeze(false);
          return;
        case 'restore':
          deps.freeze(true);
          await deps.navigate(command.navigation, false);
          deps.restore(command.snapshot);
          deps.freeze(false);
          return;
        case 'navigate':
          await deps.navigate(command.navigation);
          return;
        case 'resume':
          deps.resume();
          deps.freeze(false);
          return;
        case 'flush': {
          deps.freeze(true);
          const ids = deps.sessionIds();
          const snapshot = await deps.capture(ids);
          await deps.save(snapshot);
          deps.detach(ids);
          return { snapshot, activeSessionId: deps.activeSessionId() };
        }
      }
    } catch (error) {
      deps.resume();
      deps.freeze(false);
      throw error;
    }
  };
}
