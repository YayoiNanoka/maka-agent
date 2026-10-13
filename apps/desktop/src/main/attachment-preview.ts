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

import { Buffer } from 'node:buffer';
import { MAX_ATTACHMENT_BYTES, sniffAttachmentMimeType } from '@maka/core/attachments';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import type { SessionLocalAttachmentRecovery, RecoveryOwner } from './session-local-attachment-recovery.js';

export type AttachmentPreviewResult =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; reason: 'invalid' | 'not_found' | 'not_image' | 'unreadable' };

/**
 * When the thumbnail renderer can't decode the format (nativeImage has no
 * GIF/WebP support), the original bytes ship as the preview instead — the
 * renderer's <img> decodes those natively (and keeps GIFs animated). Only up
 * to this size, so a huge original never rides the IPC as a data URL.
 */
export const INLINE_PREVIEW_FALLBACK_MAX_BYTES = 12 * 1024 * 1024;

export interface AttachmentPreviewDeps {
  readFile: (path: string, maxBytes: number) => Promise<Uint8Array>;
  renderPreview: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

/**
 * Resolve a staged (not yet sent) approval attachment into thumbnail bytes
 * for the composer drawer. The approval is only PEEKED — the token must stay
 * redeemable for the eventual send — and the path never leaves main; only
 * the rendered preview does. Preview failures are soft by design: the
 * renderer falls back to the named file card and the attachment still sends.
 *
 * The read is capped at the approval's own stat size, not the global
 * attachment cap: `readFileCapped` allocates its cap up front, and a flat
 * 50MB per call turns a multi-image staging into an instant memory spike
 * (the renderer additionally serializes preview requests).
 *
 * `readFile`/`renderPreview` are injected because they depend on fs and
 * Electron's nativeImage respectively; tests pass fakes.
 */
export async function loadApprovalPreview(input: {
  senderId: number;
  approvalId: unknown;
  approvals: AttachmentApprovalRegistry;
  maxBytes?: number;
  inlineFallbackMaxBytes?: number;
} & AttachmentPreviewDeps): Promise<AttachmentPreviewResult> {
  if (typeof input.approvalId !== 'string' || input.approvalId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  const approved = input.approvals.peekApproval(input.senderId, input.approvalId);
  if (!approved) return { ok: false, reason: 'not_found' };
  const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (approved.size > maxBytes) return { ok: false, reason: 'unreadable' };
  try {
    const bytes = await input.readFile(approved.path, approved.size);
    const contentMimeType = sniffAttachmentMimeType(bytes);
    if (!contentMimeType?.startsWith('image/')) {
      return { ok: false, reason: 'not_image' };
    }
    const preview = await input.renderPreview(bytes);
    if (preview) {
      return {
        ok: true,
        base64: Buffer.from(preview.bytes).toString('base64'),
        mimeType: preview.mimeType,
      };
    }
    const fallbackCap = input.inlineFallbackMaxBytes ?? INLINE_PREVIEW_FALLBACK_MAX_BYTES;
    if (bytes.byteLength <= fallbackCap) {
      return { ok: true, base64: Buffer.from(bytes).toString('base64'), mimeType: contentMimeType };
    }
    return { ok: false, reason: 'unreadable' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** Recovery data is only exposed as a freshly encoded thumbnail, never original bytes. */
export async function loadRecoveryApprovalPreview(input: {
  senderId: number;
  approvalId: string;
  recovery: SessionLocalAttachmentRecovery;
  authorizeRecovery(owner: RecoveryOwner): boolean;
  renderPreview: AttachmentPreviewDeps['renderPreview'];
}): Promise<AttachmentPreviewResult> {
  const owner = input.recovery.ownerForPreview(input.senderId, input.approvalId);
  if (!owner || !input.authorizeRecovery(owner)) return { ok: false, reason: 'not_found' };
  try {
    const { content } = input.recovery.snapshot(owner, input.approvalId);
    if (content.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'unreadable' };
    if (!sniffAttachmentMimeType(content)?.startsWith('image/')) return { ok: false, reason: 'not_image' };
    const preview = await input.renderPreview(content);
    // A window can close or its Host authorization can be revoked while the
    // decoder runs. Never return an already revoked snapshot to that renderer.
    if (!input.recovery.ownerForPreview(input.senderId, input.approvalId) || !input.authorizeRecovery(owner))
      return { ok: false, reason: 'not_found' };
    if (!preview || preview.mimeType !== 'image/png' || preview.bytes.byteLength > INLINE_PREVIEW_FALLBACK_MAX_BYTES)
      return { ok: false, reason: 'unreadable' };
    return { ok: true, base64: Buffer.from(preview.bytes).toString('base64'), mimeType: preview.mimeType };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * Register the client-owned attachment preview boundary used by Runtime Host
 * Desktop. Preview admission and byte validation remain local because the
 * renderer consumes this native presentation capability directly.
 */
export function registerAttachmentPreviewIpc(input: {
  ipcMain: {
    handle(
      channel: string,
      listener: (event: { sender: { id: number } }, approvalId: unknown) => Promise<AttachmentPreviewResult>,
    ): void;
  };
  approvals: AttachmentApprovalRegistry;
  recovery: SessionLocalAttachmentRecovery;
  authorizeRecovery(owner: RecoveryOwner): boolean;
} & AttachmentPreviewDeps): void {
  input.ipcMain.handle('attachments:previewApproval', (event, approvalId) =>
    typeof approvalId === 'string' && approvalId.startsWith('local-recovery:')
      ? loadRecoveryApprovalPreview({ senderId: event.sender.id, approvalId, recovery: input.recovery, authorizeRecovery: input.authorizeRecovery, renderPreview: input.renderPreview })
      : loadApprovalPreview({
      senderId: event.sender.id,
      approvalId,
      approvals: input.approvals,
      readFile: input.readFile,
      renderPreview: input.renderPreview,
    }),
  );
}
