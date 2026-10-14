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

import type { AttachmentRef, DirectoryReference, InlineReference, QuoteRef } from '@maka/core/events';

/** Sources entering main never carry renderer URLs or filesystem paths. */
export type SessionWorkspaceAttachment =
  | { readonly type: 'retained'; readonly attachment: AttachmentRef }
  | { readonly type: 'approval'; readonly approvalId: string; readonly name: string; readonly mimeType?: string; readonly size: number }
  | { readonly type: 'upload'; readonly name: string; readonly mimeType?: string; readonly base64: string };

export interface SessionWorkspaceRevision {
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly copyId: string;
  readonly copyPhase: string;
  readonly draftSessionId: string;
  readonly previousComposerText: string;
  readonly originalQuotes: readonly QuoteRef[];
  readonly originalAttachments: readonly AttachmentRef[];
}

export interface SessionWorkspaceDraft {
  readonly revision?: SessionWorkspaceRevision;
  readonly retractedReferences?: readonly InlineReference[];
  readonly sessionId: string;
  readonly text: string;
  readonly references: readonly InlineReference[];
  readonly replacesMessageId?: string;
  readonly attachments: readonly SessionWorkspaceAttachment[];
  readonly directoryReferences: readonly DirectoryReference[];
  readonly quotes: readonly QuoteRef[];
}

export interface SideConversationWorkspaceState {
  readonly panel: {
    readonly id: string;
    readonly sourceSessionId: string;
    readonly quotes: { id: string; value: QuoteRef }[];
    readonly initialPrompt?: string;
  };
  readonly hasContent: boolean;
  readonly active: boolean;
  readonly companion?: {
    readonly sessionId: string;
    readonly ownTurnIds: readonly string[];
    readonly queueOwnedMessageIds: readonly string[];
  };
  readonly draft: SessionWorkspaceDraft;
}

/** Process-lifetime handoff state; never persisted or used to restore windows on restart. */
export interface SessionWorkspaceSnapshot {
  readonly workbar?: Readonly<Record<string, import('./session-workbar-state.js').SessionWorkbarLayoutSnapshot>>;
  readonly readingAnchors?: Readonly<Record<string, { readonly turnId: string }>>;
  readonly capturedAt: number;
  readonly drafts: readonly SessionWorkspaceDraft[];
  readonly sideConversations: readonly SideConversationWorkspaceState[];
}
