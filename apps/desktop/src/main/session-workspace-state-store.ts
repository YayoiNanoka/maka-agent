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

import { chmodSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  readonly source?: { readonly approvalId: string; readonly senderId: number; readonly hostId: string; readonly targetEpoch: string; readonly sessionId: string };
};
type StoredDraft = Omit<SessionWorkspaceDraft, 'attachments'> & { attachments: readonly StoredAttachment[] };
type StoredSide = Omit<SideConversationWorkspaceState, 'draft'> & { draft: StoredDraft };
type AttachmentBytes = { name: string; mimeType: string; content: Uint8Array };

/** Client-owned drafts, separate from admitted messages and window restoration. */
export class SessionWorkspaceStateStore {
  readonly #db: DatabaseSync;
  readonly #pending = new Map<string, Promise<void>>();
  #revision = 0;
  readonly #deleted = new Set<string>();
  #wasDeleted(partition: string, sessionId: string): boolean { return this.#deleted.has(JSON.stringify([partition, sessionId])); }
  constructor(path: string, private readonly sources: {
    approvals: AttachmentApprovalRegistry;
    recovery: SessionLocalAttachmentRecovery;
  }) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspace_states (
        partition TEXT NOT NULL, item_key TEXT NOT NULL, source_key TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, captured_at INTEGER NOT NULL,
        PRIMARY KEY(partition, item_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_ui (
        partition TEXT NOT NULL, session_key TEXT NOT NULL, payload TEXT NOT NULL, captured_at INTEGER NOT NULL,
        PRIMARY KEY(partition, session_key)
      );
      CREATE TABLE IF NOT EXISTS workspace_attachments (
        partition TEXT NOT NULL, item_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, content BLOB NOT NULL,
        PRIMARY KEY(partition, item_key, ordinal),
        FOREIGN KEY(partition, item_key) REFERENCES workspace_states(partition, item_key) ON DELETE CASCADE
      );
    `);
  }

  #recoveryOwner(owner: SessionWorkspaceOwner, key: string): RecoveryOwner {
    const ref = parseDesktopSessionKey(key);
    if (ref.hostId !== owner.scope.hostId) throw new Error('Workspace draft belongs to a different Host');
    return { ...owner, sessionId: ref.sessionId };
  }

  #custodiedAttachment(owner: SessionWorkspaceOwner, itemKey: string, sessionId: string, approvalId: string): AttachmentBytes | undefined {
    const row = this.#db.prepare('SELECT payload, kind FROM workspace_states WHERE partition = ? AND item_key = ?').get(owner.partition, itemKey);
    if (!row) return undefined;
    const payload = JSON.parse(String(row.payload)) as StoredDraft | StoredSide;
    const draft = row.kind === 'draft' ? payload as StoredDraft : (payload as StoredSide).draft;
    const item = draft.attachments.find((item) => item.type === 'stored' && item.source?.approvalId === approvalId &&
      item.source.senderId === owner.senderId && item.source.hostId === owner.scope.hostId &&
      item.source.targetEpoch === owner.scope.targetEpoch && item.source.sessionId === sessionId);
    if (!item || item.type !== 'stored') return undefined;
    const saved = this.#db.prepare('SELECT name, mime_type, content FROM workspace_attachments WHERE partition = ? AND item_key = ? AND ordinal = ?').get(owner.partition, itemKey, item.ordinal);
    if (!saved) throw new Error('Saved workspace attachment is missing');
    return { name: String(saved.name), mimeType: String(saved.mime_type), content: saved.content as Uint8Array };
  }

  async #prepareDraft(owner: SessionWorkspaceOwner, itemKey: string, draft: SessionWorkspaceDraft): Promise<{ draft: StoredDraft; bytes: AttachmentBytes[]; revalidate(): void }> {
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
      // Custody was established by an earlier authenticated save of this exact
      // draft and owner. Reuse those bytes after picker/recovery TTL expiry; never
      // reopen a path or accept a token merely because another draft saved it.
      const custodied = attachment.type === 'approval'
        ? this.#custodiedAttachment(owner, itemKey, draft.sessionId, attachment.approvalId) : undefined;
      if (custodied) {
        saved = custodied;
      } else if (attachment.type === 'approval' && attachment.approvalId.startsWith('local-recovery:')) {
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
        // Keep the source approval alive: periodic saves and rollback still use it.
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
      attachments.push({ type: 'stored', ordinal: bytes.length - 1, name: saved.name, mimeType: saved.mimeType, size: saved.content.byteLength,
        ...(attachment.type === 'approval' ? { source: { approvalId: attachment.approvalId, senderId: owner.senderId,
          hostId: owner.scope.hostId, targetEpoch: owner.scope.targetEpoch, sessionId: draft.sessionId } } : {}),
      });
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

  save(owner: SessionWorkspaceOwner, snapshot: SessionWorkspaceSnapshot): Promise<void> {
    // Serialize asynchronous file reads as well as the SQLite write, so a slow
    // earlier save cannot overwrite a final close snapshot.
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
    const entries: Array<{ key: string; source: string; kind: string; payload: StoredDraft | StoredSide; bytes: AttachmentBytes[] }> = [];
    const members = new Set(snapshot.drafts.map((draft) => draft.sessionId).filter((key) => !this.#wasDeleted(owner.partition, key)));
    for (const draft of snapshot.drafts) {
      if (!members.has(draft.sessionId)) continue;
      let prepared;
      try { prepared = await this.#prepareDraft(owner, `draft:${draft.sessionId}`, draft); }
      catch (error) {
        if (this.#wasDeleted(owner.partition, draft.sessionId)) continue;
        throw error;
      }
      revalidations.push({ source: draft.sessionId, validate: prepared.revalidate });
      entries.push({ key: `draft:${draft.sessionId}`, source: draft.sessionId, kind: 'draft', payload: prepared.draft, bytes: prepared.bytes });
    }
    for (const side of snapshot.sideConversations) {
      if (this.#wasDeleted(owner.partition, side.panel.sourceSessionId)) continue;
      if (!members.has(side.panel.sourceSessionId)) throw new Error('Side conversation is outside the workspace snapshot');
      let prepared;
      try { prepared = await this.#prepareDraft(owner, `side:${side.panel.id}`, side.draft); }
      catch (error) {
        if (this.#wasDeleted(owner.partition, side.panel.sourceSessionId)) continue;
        throw error;
      }
      revalidations.push({ source: side.panel.sourceSessionId, validate: prepared.revalidate });
      entries.push({ key: `side:${side.panel.id}`, source: side.panel.sourceSessionId, kind: 'side',
        payload: { ...structuredClone(side), draft: prepared.draft }, bytes: prepared.bytes });
    }
    for (const member of members) if (this.#wasDeleted(owner.partition, member)) members.delete(member);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (!members.has(entries[index]!.source)) entries.splice(index, 1);
    }
    for (const item of revalidations) if (members.has(item.source)) item.validate();
    if (revision !== this.#revision) throw new Error('Workspace authorization was cleared during save');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const source of members) {
        this.#db.prepare('DELETE FROM workspace_states WHERE partition = ? AND source_key = ? AND captured_at <= ?')
          .run(owner.partition, source, snapshot.capturedAt);
      }
      for (const source of members) {
        const ui = { workbar: snapshot.workbar?.[source], readingAnchor: snapshot.readingAnchors?.[source] };
        const payload = JSON.stringify(ui);
        if (payload.length > 1_000_000) throw new Error('Workspace layout is too large');
        this.#db.prepare(`INSERT INTO workspace_ui VALUES (?, ?, ?, ?)
          ON CONFLICT(partition, session_key) DO UPDATE SET payload=excluded.payload, captured_at=excluded.captured_at
          WHERE excluded.captured_at >= workspace_ui.captured_at`).run(owner.partition, source, payload, snapshot.capturedAt);
      }
      const write = this.#db.prepare('INSERT OR REPLACE INTO workspace_states VALUES (?, ?, ?, ?, ?, ?)');
      const writeAttachment = this.#db.prepare('INSERT INTO workspace_attachments VALUES (?, ?, ?, ?, ?, ?)');
      for (const entry of entries) {
        const newer = this.#db.prepare('SELECT captured_at FROM workspace_states WHERE partition = ? AND item_key = ?').get(owner.partition, entry.key);
        if (newer && Number(newer.captured_at) > snapshot.capturedAt) continue;
        write.run(owner.partition, entry.key, entry.source, entry.kind, JSON.stringify(entry.payload), snapshot.capturedAt);
        entry.bytes.forEach((item, ordinal) => writeAttachment.run(owner.partition, entry.key, ordinal, item.name, item.mimeType, item.content));
      }
      const storedBytes = this.#db.prepare('SELECT COALESCE(SUM(length(content)), 0) AS bytes FROM workspace_attachments').get();
      if (Number(storedBytes?.bytes) > 256 * 1024 * 1024) throw new AttachmentIngestBlockedError('total_size_exceeded');
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  load(owner: SessionWorkspaceOwner, sessionIds: readonly string[]): SessionWorkspaceSnapshot {
    const drafts: SessionWorkspaceDraft[] = [];
    const sideConversations: SideConversationWorkspaceState[] = [];
    const workbar: Record<string, import('../shared/session-workbar-state.js').SessionWorkbarLayoutSnapshot> = {};
    const readingAnchors: Record<string, { readonly turnId: string }> = {};
    let capturedAt = 0;
    const issued: string[] = [];
    const restore = (key: string, draft: StoredDraft): SessionWorkspaceDraft => ({
      ...draft,
      attachments: draft.attachments.map((item): SessionWorkspaceAttachment => {
        if (item.type === 'retained') return item;
        const row = this.#db.prepare('SELECT name, mime_type, content FROM workspace_attachments WHERE partition = ? AND item_key = ? AND ordinal = ?').get(owner.partition, key, item.ordinal);
        if (!row) throw new Error('Saved workspace attachment is missing');
        const approval = this.sources.recovery.issue(this.#recoveryOwner(owner, draft.sessionId), [{
          name: String(row.name), mimeType: String(row.mime_type), content: row.content as Uint8Array,
        }])[0]!;
        issued.push(approval.approvalId);
        return { type: 'approval', ...approval };
      }),
    });
    try {
      for (const sessionId of new Set(sessionIds)) {
        this.#recoveryOwner(owner, sessionId);
        const uiRow = this.#db.prepare('SELECT payload FROM workspace_ui WHERE partition = ? AND session_key = ?').get(owner.partition, sessionId);
        if (uiRow) {
          const ui = JSON.parse(String(uiRow.payload));
          if (ui.workbar) workbar[sessionId] = ui.workbar;
          if (ui.readingAnchor) readingAnchors[sessionId] = ui.readingAnchor;
        }
        const rows = this.#db.prepare('SELECT item_key, kind, payload, captured_at FROM workspace_states WHERE partition = ? AND source_key = ?').all(owner.partition, sessionId);
        let hasDraft = false;
        for (const row of rows) {
          capturedAt = Math.max(capturedAt, Number(row.captured_at));
          if (row.kind === 'draft') {
            drafts.push(restore(String(row.item_key), JSON.parse(String(row.payload)) as StoredDraft));
            hasDraft = true;
          } else {
            const side = JSON.parse(String(row.payload)) as StoredSide;
            sideConversations.push({ ...side, draft: restore(String(row.item_key), side.draft) });
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

  delete(partition: string, sessionIds: readonly string[]): void {
    for (const key of sessionIds) {
      this.#deleted.add(JSON.stringify([partition, key]));
      this.#db.prepare('DELETE FROM workspace_states WHERE partition = ? AND source_key = ?').run(partition, key);
      this.#db.prepare('DELETE FROM workspace_ui WHERE partition = ? AND session_key = ?').run(partition, key);
    }
  }

  clear(partition?: string): void {
    this.#revision += 1;
    if (partition === undefined) this.#db.exec('DELETE FROM workspace_states; DELETE FROM workspace_ui');
    else {
      this.#db.prepare('DELETE FROM workspace_states WHERE partition = ?').run(partition);
      this.#db.prepare('DELETE FROM workspace_ui WHERE partition = ?').run(partition);
    }
  }
  close(): void { this.#db.close(); }
}
