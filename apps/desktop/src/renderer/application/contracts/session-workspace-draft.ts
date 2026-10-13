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

import { AttachmentIngestBlockedError, MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import type { PendingAttachment } from '@maka/ui/composer-attachments';
import type { SessionWorkspaceAttachment, SessionWorkspaceDraft } from '../../../shared/session-workspace-state.js';

/** Blob bytes may leave their originating renderer; recovery bytes never do. */
export async function captureWorkspaceAttachments(attachments: readonly PendingAttachment[]): Promise<SessionWorkspaceAttachment[]> {
  const captured: SessionWorkspaceAttachment[] = [];
  for (const item of attachments) {
    const source = item.source;
    if (source.type === 'retained') captured.push({ type: 'retained', attachment: structuredClone(source.attachment) });
    else if (source.type === 'approval') captured.push({ type: 'approval', approvalId: source.approvalId, name: source.name, mimeType: item.mimeType, size: item.size });
    else {
      if (source.file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentIngestBlockedError('item_too_large');
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new AttachmentIngestBlockedError('item_unreadable'));
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(source.file);
      });
      captured.push({ type: 'upload', name: source.file.name, mimeType: item.mimeType, base64 });
    }
  }
  return captured;
}

export function workspaceDraftContext(draft: SessionWorkspaceDraft) {
  if (draft.attachments.some((item) => item.type === 'upload')) throw new Error('Workspace attachments must be approved by main before restore');
  return {
    attachments: draft.attachments.flatMap((item) => item.type === 'retained' ? [item.attachment] : []),
    stagedAttachments: draft.attachments.flatMap((item) => item.type === 'approval' ? [{ approvalId: item.approvalId, name: item.name, mimeType: item.mimeType, size: item.size }] : []),
    directoryReferences: draft.directoryReferences, quotes: draft.quotes,
  };
}
