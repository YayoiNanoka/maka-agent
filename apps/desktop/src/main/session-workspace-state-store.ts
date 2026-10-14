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

import { stat } from 'node:fs/promises';
import { AttachmentIngestBlockedError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, resolveAttachmentMimeType } from '@maka/core/attachments';
import { isAttachmentRef, isDirectoryReference, isInlineReference, isQuoteRef } from '@maka/core/events';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import { prepareIngestItems, resolveAttachmentRefs } from './attachment-ingest.js';
import { SessionLocalAttachmentRecovery, type RecoveryOwner } from './session-local-attachment-recovery.js';
import { MAX_LOCAL_MESSAGE_BYTES } from './session-local-store.js';
import { parseDesktopSessionKey, type DesktopTargetScope } from '../shared/runtime-host-identity.js';
import type { SessionWorkspaceAttachment, SessionWorkspaceDraft, SessionWorkspaceSnapshot, SideConversationWorkspaceState } from '../shared/session-workspace-state.js';

export interface SessionWorkspaceOwner {
  readonly senderId: number;
  readonly partition: string;
  readonly scope: DesktopTargetScope;
}

type StoredAttachment = Exclude<SessionWorkspaceAttachment, { type: 'approval' | 'upload' }> | {
  readonly type: 'stored'; readonly ordinal: number; readonly name: string; readonly mimeType: string; readonly size: number;
};
type StoredDraft = Omit<SessionWorkspaceDraft, 'attachments'> & { attachments: readonly StoredAttachment[] };
type StoredSide = Omit<SideConversationWorkspaceState, 'draft'> & { draft: StoredDraft };
type AttachmentBytes = { name: string; mimeType: string; content: Uint8Array };
type StoredEntry = { kind: 'draft' | 'side'; payload: StoredDraft | StoredSide; bytes: AttachmentBytes[] };
type StoredWorkspace = {
  capturedAt: number;
  entries: StoredEntry[];
  workbar?: import('../shared/session-workbar-state.js').SessionWorkbarLayoutSnapshot;
  readingAnchor?: { readonly turnId: string };
};

/** Process-lifetime custody while an existing draft moves between windows. */
export class SessionWorkspaceStateStore {
  readonly #workspaces = new Map<string, Map<string, StoredWorkspace>>();
  readonly #pending = new Map<string, Promise<void>>();
  #revision = 0;
  #closed = false;
  readonly #deleted = new Set<string>();
  #wasDeleted(partition: string, sessionId: string): boolean { return this.#deleted.has(JSON.stringify([partition, sessionId])); }
  constructor(private readonly sources: {
    approvals: AttachmentApprovalRegistry;
    recovery: SessionLocalAttachmentRecovery;
  }) {}

  #recoveryOwner(owner: SessionWorkspaceOwner, key: string): RecoveryOwner {
    const ref = parseDesktopSessionKey(key);
    if (ref.hostId !== owner.scope.hostId) throw new Error('Workspace draft belongs to a different Host');
    return { ...owner, sessionId: ref.sessionId };
  }

  async #prepareDraft(owner: SessionWorkspaceOwner, draft: SessionWorkspaceDraft): Promise<{ draft: StoredDraft; bytes: AttachmentBytes[]; revalidate(): void }> {
    this.#recoveryOwner(owner, draft.sessionId);
    if (typeof draft.text !== 'string' || draft.text.length > 2_000_000 || !Array.isArray(draft.references) ||
        !Array.isArray(draft.quotes) || !Array.isArray(draft.directoryReferences) || !Array.isArray(draft.attachments) ||
        !draft.references.every(isInlineReference) || !draft.quotes.every(isQuoteRef) || !draft.directoryReferences.every(isDirectoryReference))
      throw new Error('Invalid workspace draft');
    if (draft.attachments.length > MAX_ATTACHMENT_COUNT) throw new AttachmentIngestBlockedError('count_limit');
    const bytes: AttachmentBytes[] = [];
    const attachments: StoredAttachment[] = [];
    const seen = new Set<string>();
    const revalidations: Array<() => void> = [];
    for (const attachment of draft.attachments) {
      if (attachment.type === 'retained') {
        if (!isAttachmentRef(attachment.attachment)) throw new Error('Invalid retained workspace attachment');
        attachments.push(structuredClone(attachment));
        continue;
      }
      let saved: AttachmentBytes;
      if (attachment.type === 'approval') {
        if (seen.has(attachment.approvalId)) throw new AttachmentIngestBlockedError('duplicate_source');
        seen.add(attachment.approvalId);
      }
      if (attachment.type === 'approval' && attachment.approvalId.startsWith('local-recovery:')) {
        revalidations.push(() => { this.sources.recovery.snapshot(this.#recoveryOwner(owner, draft.sessionId), attachment.approvalId); });
        saved = this.sources.recovery.snapshot(this.#recoveryOwner(owner, draft.sessionId), attachment.approvalId);
      } else {
        const prepared = await prepareIngestItems({
          senderId: owner.senderId, approvals: this.sources.approvals, stat,
          items: attachment.type === 'approval' ? [attachment] : attachment.type === 'upload' ? [attachment] : null,
          maxBytes: MAX_ATTACHMENT_BYTES, maxTotalBytes: MAX_LOCAL_MESSAGE_BYTES,
        });
        const snapshots = await resolveAttachmentRefs({
          files: prepared.files, maxTotalBytes: MAX_LOCAL_MESSAGE_BYTES,
          snapshot: async (item) => ({ name: item.name, mimeType: item.mimeType, content: item.content }),
        });
        // Keep the source approval alive until transfer succeeds or rolls back.
        if (attachment.type === 'approval' && !this.sources.approvals.peekApproval(owner.senderId, attachment.approvalId))
          throw new AttachmentIngestBlockedError('source_expired');
        if (attachment.type === 'approval') revalidations.push(() => {
          if (!this.sources.approvals.peekApproval(owner.senderId, attachment.approvalId)) throw new AttachmentIngestBlockedError('source_expired');
        });
        saved = snapshots[0]!;
      }
      saved.mimeType = resolveAttachmentMimeType(saved.content, saved.mimeType, saved.name);
      bytes.push(saved);
      if (bytes.reduce((sum, entry) => sum + entry.content.byteLength, 0) > MAX_LOCAL_MESSAGE_BYTES)
        throw new AttachmentIngestBlockedError('total_size_exceeded');
      attachments.push({ type: 'stored', ordinal: bytes.length - 1, name: saved.name, mimeType: saved.mimeType, size: saved.content.byteLength });
    }
    const safeDraft: StoredDraft = {
      sessionId: draft.sessionId, text: draft.text, references: structuredClone(draft.references),
      ...(draft.revision ? { revision: structuredClone(draft.revision) } : {}),
      ...(draft.retractedReferences ? { retractedReferences: structuredClone(draft.retractedReferences) } : {}),
      ...(draft.replacesMessageId ? { replacesMessageId: draft.replacesMessageId } : {}),
      quotes: structuredClone(draft.quotes), directoryReferences: structuredClone(draft.directoryReferences), attachments,
    };
    if (JSON.stringify(safeDraft).length > 4_000_000) throw new Error('Workspace draft is too large');
    return { draft: safeDraft, bytes, revalidate: () => { for (const validate of revalidations) validate(); } };
  }

  /** A window may contain several Hosts; a failed flush leaves all drafts with it. */
  async saveAll(workspaces: readonly { owner: SessionWorkspaceOwner; snapshot: SessionWorkspaceSnapshot }[]): Promise<void> {
    try {
      for (const { owner, snapshot } of workspaces) await this.save(owner, snapshot);
    } catch (error) {
      for (const { owner, snapshot } of workspaces) {
        this.forget(owner.partition, snapshot.drafts.map((draft) => draft.sessionId), snapshot.capturedAt);
      }
      throw error;
    }
  }

  save(owner: SessionWorkspaceOwner, snapshot: SessionWorkspaceSnapshot): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Workspace handoff store is closed'));
    // Serialize asynchronous file reads so a slow earlier transfer cannot
    // overwrite the state captured when its source window closes.
    const pendingKey = JSON.stringify([owner.partition, owner.scope.hostId]);
    const revision = this.#revision;
    const previous = this.#pending.get(pendingKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#save(owner, snapshot, revision));
    this.#pending.set(pendingKey, next);
    void next.finally(() => { if (this.#pending.get(pendingKey) === next) this.#pending.delete(pendingKey); }).catch(() => {});
    return next;
  }

  async #save(owner: SessionWorkspaceOwner, snapshot: SessionWorkspaceSnapshot, revision: number): Promise<void> {
    if (!snapshot || !Array.isArray(snapshot.drafts) || !Array.isArray(snapshot.sideConversations) || !Number.isFinite(snapshot.capturedAt))
      throw new Error('Invalid workspace snapshot');
    const revalidations: Array<{ source: string; validate(): void }> = [];
    const entries: Array<StoredEntry & { source: string }> = [];
    const members = new Set(snapshot.drafts.map((draft) => draft.sessionId).filter((key) => !this.#wasDeleted(owner.partition, key)));
    for (const draft of snapshot.drafts) {
      if (!members.has(draft.sessionId)) continue;
      let prepared;
      try { prepared = await this.#prepareDraft(owner, draft); }
      catch (error) {
        if (this.#wasDeleted(owner.partition, draft.sessionId)) continue;
        throw error;
      }
      revalidations.push({ source: draft.sessionId, validate: prepared.revalidate });
      entries.push({ source: draft.sessionId, kind: 'draft', payload: prepared.draft, bytes: prepared.bytes });
    }
    for (const side of snapshot.sideConversations) {
      if (this.#wasDeleted(owner.partition, side.panel.sourceSessionId)) continue;
      if (!members.has(side.panel.sourceSessionId)) throw new Error('Side conversation is outside the workspace snapshot');
      let prepared;
      try { prepared = await this.#prepareDraft(owner, side.draft); }
      catch (error) {
        if (this.#wasDeleted(owner.partition, side.panel.sourceSessionId)) continue;
        throw error;
      }
      revalidations.push({ source: side.panel.sourceSessionId, validate: prepared.revalidate });
      entries.push({ source: side.panel.sourceSessionId, kind: 'side',
        payload: { ...structuredClone(side), draft: prepared.draft }, bytes: prepared.bytes });
    }
    for (const member of members) if (this.#wasDeleted(owner.partition, member)) members.delete(member);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (!members.has(entries[index]!.source)) entries.splice(index, 1);
    }
    for (const item of revalidations) if (members.has(item.source)) item.validate();
    if (revision !== this.#revision) throw new Error('Workspace authorization was cleared during save');
    const next = new Map(this.#workspaces.get(owner.partition));
    for (const source of members) {
      if ((next.get(source)?.capturedAt ?? -Infinity) > snapshot.capturedAt) continue;
      const ui = { workbar: snapshot.workbar?.[source], readingAnchor: snapshot.readingAnchors?.[source] };
      if (JSON.stringify(ui).length > 1_000_000) throw new Error('Workspace layout is too large');
      next.set(source, {
        capturedAt: snapshot.capturedAt,
        entries: entries.filter((entry) => entry.source === source),
        ...structuredClone(ui),
      });
    }
    let storedBytes = 0;
    const countBytes = (workspaces: Map<string, StoredWorkspace>) => {
      for (const workspace of workspaces.values()) for (const entry of workspace.entries)
        for (const attachment of entry.bytes) storedBytes += attachment.content.byteLength;
    };
    countBytes(next);
    for (const [partition, workspaces] of this.#workspaces) if (partition !== owner.partition) countBytes(workspaces);
    if (storedBytes > 256 * 1024 * 1024) throw new AttachmentIngestBlockedError('total_size_exceeded');
    // Publish only after every draft and attachment succeeds, preserving the
    // previous snapshot for a failed transfer's rollback.
    this.#workspaces.set(owner.partition, next);
  }

  load(owner: SessionWorkspaceOwner, sessionIds: readonly string[]): SessionWorkspaceSnapshot {
    if (this.#closed) throw new Error('Workspace handoff store is closed');
    const drafts: SessionWorkspaceDraft[] = [];
    const sideConversations: SideConversationWorkspaceState[] = [];
    const workbar: Record<string, import('../shared/session-workbar-state.js').SessionWorkbarLayoutSnapshot> = {};
    const readingAnchors: Record<string, { readonly turnId: string }> = {};
    let capturedAt = 0;
    const issued: string[] = [];
    const restore = (bytes: AttachmentBytes[], draft: StoredDraft): SessionWorkspaceDraft => ({
      ...draft,
      attachments: draft.attachments.map((item): SessionWorkspaceAttachment => {
        if (item.type === 'retained') return item;
        const saved = bytes[item.ordinal];
        if (!saved) throw new Error('Saved workspace attachment is missing');
        const approval = this.sources.recovery.issue(this.#recoveryOwner(owner, draft.sessionId), [saved])[0]!;
        issued.push(approval.approvalId);
        return { type: 'approval', ...approval };
      }),
    });
    try {
      for (const sessionId of new Set(sessionIds)) {
        this.#recoveryOwner(owner, sessionId);
        const workspace = this.#workspaces.get(owner.partition)?.get(sessionId);
        if (workspace?.workbar) workbar[sessionId] = structuredClone(workspace.workbar);
        if (workspace?.readingAnchor) readingAnchors[sessionId] = structuredClone(workspace.readingAnchor);
        capturedAt = Math.max(capturedAt, workspace?.capturedAt ?? 0);
        let hasDraft = false;
        for (const entry of workspace?.entries ?? []) {
          if (entry.kind === 'draft') {
            drafts.push(restore(entry.bytes, structuredClone(entry.payload) as StoredDraft));
            hasDraft = true;
          } else {
            const side = structuredClone(entry.payload) as StoredSide;
            sideConversations.push({ ...side, draft: restore(entry.bytes, side.draft) });
          }
        }
        if (!hasDraft) drafts.push({ sessionId, text: '', references: [], attachments: [], directoryReferences: [], quotes: [] });
      }
      return { capturedAt, drafts, sideConversations, workbar, readingAnchors };
    } catch (error) {
      this.sources.recovery.release(owner.senderId, issued);
      throw error;
    }
  }

  /** Discard destination approvals after an interrupted or failed restoration. */
  releaseSnapshot(senderId: number, snapshot: SessionWorkspaceSnapshot): void {
    const ids = new Set<string>();
    for (const draft of [...snapshot.drafts, ...snapshot.sideConversations.map((side) => side.draft)]) {
      for (const item of draft.attachments) {
        if (item.type === 'approval' && item.approvalId.startsWith('local-recovery:')) ids.add(item.approvalId);
      }
    }
    this.sources.recovery.release(senderId, [...ids]);
  }

  /** The destination now owns these drafts; do not replay them on a later reload. */
  forget(partition: string, sessionIds: readonly string[], capturedAt: number): void {
    const workspaces = this.#workspaces.get(partition);
    if (!workspaces) return;
    for (const key of sessionIds) {
      const workspace = workspaces.get(key);
      if (workspace && workspace.capturedAt <= capturedAt) workspaces.delete(key);
    }
    if (!workspaces.size) this.#workspaces.delete(partition);
  }

  delete(partition: string, sessionIds: readonly string[]): void {
    for (const key of sessionIds) {
      this.#deleted.add(JSON.stringify([partition, key]));
      this.#workspaces.get(partition)?.delete(key);
    }
  }

  clear(partition?: string): void {
    this.#revision += 1;
    if (partition === undefined) this.#workspaces.clear();
    else this.#workspaces.delete(partition);
  }
  close(): void {
    this.#closed = true;
    this.clear();
    this.#deleted.clear();
    this.#pending.clear();
  }
}
