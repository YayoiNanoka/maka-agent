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

import type { ComposerHandle } from '@maka/ui';
import type { SessionWorkspaceDraft, SessionWorkspaceSnapshot } from '../../../shared/session-workspace-state.js';
import { captureSideConversationWorkspace, clearSideConversationWorkspace, restoreSideConversationWorkspace, detachSideConversationWorkspace, resumeSideConversationWorkspace } from './session-side-conversation-handoff.js';

import { captureWorkspaceAttachments, workspaceDraftContext } from './session-workspace-draft.js';

/** Lifecycle ports implemented by the conversation feature's existing owners. */
export interface WorkspaceStagingOwner {
  flushImports(): Promise<void>;
  captureDrafts(keys: readonly string[]): readonly {
    readonly draftKey: string;
    readonly attachments: readonly import('@maka/ui/composer-attachments').PendingAttachment[];
    readonly directoryReferences: SessionWorkspaceDraft['directoryReferences'];
    readonly quotes: SessionWorkspaceDraft['quotes'];
  }[];
  clearDrafts(keys: readonly string[]): void;
  replaceDrafts(drafts: readonly { draftKey: string; context: ReturnType<typeof workspaceDraftContext> }[]): void;
}
export interface WorkspaceSubmissionOwner {
  waitForPendingSends(): Promise<void>;
  captureWorkspace(sessionIds: readonly string[]): { revision?: SessionWorkspaceDraft['revision']; retractedReferences: Readonly<Record<string, SessionWorkspaceDraft['references']>> };
  restoreWorkspace(drafts: readonly SessionWorkspaceDraft[]): void;
  clearWorkspace(sessionIds: readonly string[]): void;
}
type WorkspaceOwners = { readonly composer: ComposerHandle | null; readonly staging: WorkspaceStagingOwner; readonly submission?: WorkspaceSubmissionOwner };

export async function captureSessionWorkspace(input: WorkspaceOwners & { readonly sessionIds: readonly string[] }): Promise<SessionWorkspaceSnapshot> {
  await input.composer?.waitForDraftReady();
  await input.submission?.waitForPendingSends();
  if (!input.composer) {
    return { capturedAt: Date.now(), drafts: [], sideConversations: [] };
  }
  await input.staging.flushImports();
  const editing = input.submission?.captureWorkspace(input.sessionIds);
  const drafts = input.composer.captureDrafts(input.sessionIds);
  const staged = new Map(input.staging.captureDrafts(input.sessionIds).map((draft) => [draft.draftKey, draft]));
  const captured: SessionWorkspaceDraft[] = [];
  for (const draft of drafts) {
    const context = staged.get(draft.draftKey);
    captured.push({
      sessionId: draft.draftKey, text: draft.text, references: draft.references,
      ...(editing?.revision?.draftSessionId === draft.draftKey ? { revision: editing.revision } : {}),
      ...(editing?.retractedReferences[draft.draftKey]?.length ? { retractedReferences: editing.retractedReferences[draft.draftKey] } : {}),
      ...(draft.replacesMessageId ? { replacesMessageId: draft.replacesMessageId } : {}),
      attachments: await captureWorkspaceAttachments(context?.attachments ?? []),
      directoryReferences: context?.directoryReferences ?? [], quotes: context?.quotes ?? [],
    });
  }
  return { capturedAt: Date.now(), drafts: captured, sideConversations: await captureSideConversationWorkspace(input.sessionIds) };
}

export function restoreSessionWorkspace(input: WorkspaceOwners & { readonly snapshot: SessionWorkspaceSnapshot }): void {
  if (!input.composer) throw new Error('Session composer is not ready');
  input.staging.replaceDrafts(input.snapshot.drafts.map((draft) => ({ draftKey: draft.sessionId, context: workspaceDraftContext(draft) })));
  input.composer.restoreDrafts(input.snapshot.drafts.map((draft) => ({ ...draft, draftKey: draft.sessionId })));
  input.submission?.restoreWorkspace(input.snapshot.drafts);
  restoreSideConversationWorkspace(input.snapshot.sideConversations);
}

export function detachSessionWorkspace(sessionIds: readonly string[]): void {
  detachSideConversationWorkspace(sessionIds);
}

export function clearSessionWorkspace(input: WorkspaceOwners & { readonly sessionIds: readonly string[] }): void {
  clearSideConversationWorkspace(input.sessionIds);
  input.submission?.clearWorkspace(input.sessionIds);
  input.staging.clearDrafts(input.sessionIds);
  for (const key of input.sessionIds) input.composer?.clearDraft(key);
}

export function resumeSessionWorkspace(sessionIds?: readonly string[]): void {
  resumeSideConversationWorkspace(sessionIds);
}
