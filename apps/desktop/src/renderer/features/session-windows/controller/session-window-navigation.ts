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
import { collapseSessionRevisions } from '@maka/core/session-revisions';
import { hasNewTaskReloadIntent } from '../../../application/contracts/new-task-reload-intent.js';
import type { SessionWindowContext, SessionWindowNavigation } from '../ports.js';
import type { SessionWorkspaceSnapshot } from '../../../../shared/session-workspace-state.js';

/** A discarded load must release its temporary recovery handles without adopting local state. */
export async function restoreSessionWindowWorkspace(input: {
  load(): Promise<SessionWorkspaceSnapshot>;
  release(snapshot: SessionWorkspaceSnapshot): Promise<void>;
  restore(snapshot: SessionWorkspaceSnapshot): void;
  isCurrent(): boolean;
}): Promise<void> {
  const snapshot = await input.load();
  if (!input.isCurrent()) {
    await input.release(snapshot);
    return;
  }
  input.restore(snapshot);
}

/** A routed or superseded request never briefly mounts in the source window. */
export function createSessionWindowNavigator(deps: {
  route(navigation: SessionWindowNavigation): Promise<'local' | 'routed'>;
  restore(sessionId: string, isCurrent: () => boolean): Promise<void>;
  blocked(): boolean;
}) {
  let revision = 0;
  const open = async (navigation: SessionWindowNavigation, activate: () => void): Promise<void> => {
    if (deps.blocked()) return;
    const ownRevision = ++revision;
    const isCurrent = () => !deps.blocked() && ownRevision === revision;
    const route = await deps.route(navigation);
    if (route !== 'local' || !isCurrent()) return;
    await deps.restore(navigation.sessionId, isCurrent);
    if (isCurrent()) activate();
  };
  return { open, invalidate: () => { revision += 1; } };
}

/** Startup may resume history only while the user still owns the initial empty selection. */
export async function bootstrapSessionWindow(input: {
  kind: SessionWindowContext['kind'] | undefined;
  refresh(): Promise<SessionSummary[]>;
  revision(): number;
  open(id: string): void;
}): Promise<void> {
  const explicitNewTask = hasNewTaskReloadIntent();
  const initialRevision = input.revision();
  const sessions = await input.refresh();
  if (input.kind !== 'main' || explicitNewTask || hasNewTaskReloadIntent() ||
    initialRevision !== 0 || input.revision() !== initialRevision) return;
  const candidate = collapseSessionRevisions(sessions).find((session) => !session.isArchived);
  if (candidate?.lastMessageAt) input.open(candidate.id);
}
