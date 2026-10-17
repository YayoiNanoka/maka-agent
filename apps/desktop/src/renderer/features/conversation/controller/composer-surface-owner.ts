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

import type { NavSelection } from '@maka/ui';

export interface ComposerSurfaceOwner {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
}

/**
 * Async composer work must still belong to the visible session or new-task draft.
 * Navigation away from chat keeps the selected session, so the section matters too.
 */
export function createComposerSurfaceOwner(input: {
  activeIdRef: { current: string | undefined };
  navSelectionRef: { current: NavSelection };
  newTaskDraftKey?: string;
  isSessionSelected(sessionId: string | undefined): boolean;
}) {
  const captureComposerImportOwner = (): ComposerSurfaceOwner => ({
    sessionId: input.activeIdRef.current,
    navSection: input.navSelectionRef.current.section,
    ...(input.activeIdRef.current === undefined ? { newTaskDraftKey: input.newTaskDraftKey } : {}),
  });
  const isShellSurfaceOwnerActive = (owner: ComposerSurfaceOwner) =>
    input.navSelectionRef.current.section === owner.navSection &&
    input.isSessionSelected(owner.sessionId) &&
    (owner.sessionId !== undefined || owner.newTaskDraftKey === input.newTaskDraftKey);
  const isComposerImportOwnerActive = (owner: ComposerSurfaceOwner) =>
    owner.navSection === 'sessions' && isShellSurfaceOwnerActive(owner);
  const isNewChatSendSurfaceActive = (owner: ComposerSurfaceOwner) =>
    owner.sessionId === undefined && isComposerImportOwnerActive(owner);
  return {
    captureComposerImportOwner,
    isShellSurfaceOwnerActive,
    isComposerImportOwnerActive,
    isNewChatSendSurfaceActive,
  };
}
