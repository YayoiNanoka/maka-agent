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
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAttachmentApprovalRegistry } from '../attachment-approval.js';
import { SessionLocalAttachmentRecovery } from '../session-local-attachment-recovery.js';
import { SessionWorkspaceStateStore } from '../session-workspace-state-store.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import type { SessionWorkspaceDraft, SessionWorkspaceSnapshot } from '../../shared/session-workspace-state.js';

const owner = { senderId: 11, partition: 'authority-a', scope: { hostId: 'host-a', targetEpoch: 'epoch-a' } };
const key = (id: string) => desktopSessionKey({ hostId: owner.scope.hostId, sessionId: id });
const emptyDraft = (id = 'a'): SessionWorkspaceDraft => ({ sessionId: key(id), text: '', references: [], quotes: [], attachments: [], directoryReferences: [] });
const snapshot = (...drafts: SessionWorkspaceDraft[]): SessionWorkspaceSnapshot => ({ capturedAt: Date.now(), drafts, sideConversations: [] });
function fixture(t: { after(fn: () => void): void }, now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), 'maka-workspace-state-'));
  const approvals = createAttachmentApprovalRegistry({ now });
  const recovery = new SessionLocalAttachmentRecovery(now);
  const path = join(dir, 'workspace.sqlite');
  const store = new SessionWorkspaceStateStore(path, { approvals, recovery });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, store, approvals, recovery };
}

test('stores the complete group without replacing another session and survives store reopening', async (t) => {
  const { path, store, approvals, recovery } = fixture(t);
  const a: SessionWorkspaceDraft = {
    ...emptyDraft(), text: 'draft @file.ts',
    references: [{ kind: 'workspace_file', value: '@file.ts', label: 'file.ts', start: 6 }],
    quotes: [{ text: 'an excerpt', sourceTurnId: 'turn-1' }],
    directoryReferences: [{ hostId: 'host-a', path: '/project' }],
    replacesMessageId: 'local-message',
    revision: { sourceSessionId: key('a'), draftSessionId: key('a'), sourceTurnId: 'turn-2', copyId: 'copy', copyPhase: 'reserved', previousComposerText: 'previous', originalQuotes: [], originalAttachments: [] },
  };
  await store.save(owner, snapshot({ ...emptyDraft('unrelated'), text: 'keep me' }));
  await store.save(owner, { ...snapshot(a, { ...emptyDraft('child'), text: 'child draft' }), readingAnchors: { [key('a')]: { turnId: 'turn-1' } } });
  const another = new SessionWorkspaceStateStore(path, { approvals, recovery });
  try {
    const loaded = another.load({ ...owner, senderId: 22 }, [key('a'), key('child')]);
    assert.deepEqual(loaded.drafts, [a, { ...emptyDraft('child'), text: 'child draft' }]);
    assert.deepEqual(loaded.readingAnchors, { [key('a')]: { turnId: 'turn-1' } });
    assert.equal(another.load(owner, [key('unrelated')]).drafts[0]!.text, 'keep me');
    assert.equal(another.load({ ...owner, partition: 'different-authority' }, [key('a')]).drafts[0]!.text, '');
    assert.throws(() => another.load({ ...owner, scope: { ...owner.scope, hostId: 'other-host' } }, [key('a')]), /different Host/);
  } finally { another.close(); }
});

test('picked and recovery attachments are saved by main, reissued for the destination, and retain source send leases', async (t) => {
  const { dir, store, approvals, recovery } = fixture(t);
  const file = join(dir, 'picked.txt');
  writeFileSync(file, 'picked bytes');
  const picked = approvals.issueApprovals(owner.senderId, [{ path: file, name: 'picked.txt', size: 12 }])[0]!;
  const recoveryOwner = { ...owner, sessionId: 'a' };
  const recovered = recovery.issue(recoveryOwner, [{ name: 'recovered.txt', mimeType: 'text/plain', content: Buffer.from('recovery bytes') }])[0]!;
  const sending = recovery.prepare(recoveryOwner, [recovered]);
  const draft: SessionWorkspaceDraft = { ...emptyDraft(), attachments: [
    { type: 'approval', ...picked }, { type: 'approval', ...recovered },
    { type: 'upload', name: 'paste.txt', mimeType: 'text/plain', base64: Buffer.from('paste bytes').toString('base64') },
  ] };
  await store.save(owner, snapshot(draft));
  assert.ok(approvals.peekApproval(owner.senderId, picked.approvalId), 'periodic save does not consume a picker approval');
  const target = { ...owner, senderId: 22, scope: { ...owner.scope, targetEpoch: 'new-epoch' } };
  const loaded = store.load(target, [key('a')]);
  const issued = loaded.drafts[0]!.attachments;
  assert.equal(issued.length, 3);
  assert.ok(issued.every((item) => item.type === 'approval' && item.approvalId.startsWith('local-recovery:')));
  assert.ok(!JSON.stringify(loaded).includes('base64'));
  assert.ok(!JSON.stringify(loaded).includes(file));
  assert.ok(!JSON.stringify(loaded).includes(picked.approvalId));
  recovery.release(owner.senderId, [recovered.approvalId]);
  assert.equal(sending.commit(() => 'source send admitted'), 'source send admitted');
  sending.dispose();
  approvals.clearSender(owner.senderId);
  const restoredOwner = { ...target, sessionId: 'a' };
  const prepared = recovery.prepare(restoredOwner, issued);
  assert.deepEqual(prepared.items.map((item) => Buffer.from((item as { base64: string }).base64, 'base64').toString()), ['picked bytes', 'recovery bytes', 'paste bytes']);
  assert.throws(() => recovery.prepare({ ...restoredOwner, senderId: 11 }, issued), { code: 'source_expired' });
  prepared.dispose();
});

test('forged attachments fail without replacing a previously saved draft', async (t) => {
  const { store } = fixture(t);
  await store.save(owner, snapshot({ ...emptyDraft(), text: 'saved' }));
  await assert.rejects(store.save(owner, snapshot({ ...emptyDraft(), text: 'forged', attachments: [{ type: 'approval', approvalId: 'forged', name: 'secret', size: 3 }] })));
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, 'saved');
});

test('releasing abandoned large restorations keeps repeated window transfers below the recovery byte budget', async (t) => {
  const { store, recovery } = fixture(t);
  const original = recovery.issue({ ...owner, sessionId: 'a' }, [{ name: 'large.bin', mimeType: 'application/octet-stream', content: new Uint8Array(45 * 1024 * 1024) }])[0]!;
  await store.save(owner, snapshot({ ...emptyDraft(), attachments: [{ type: 'approval', ...original }] }));
  recovery.releaseSender(owner.senderId);
  const target = { ...owner, senderId: 22 };
  for (let attempt = 0; attempt < 4; attempt++) {
    const source = store.load(owner, [key('a')]);
    const destination = store.load(target, [key('a')]);
    assert.equal(destination.drafts[0]!.attachments[0]!.type, 'approval');
    store.releaseSnapshot(target.senderId, destination);
    store.releaseSnapshot(owner.senderId, source);
    const rollback = store.load(owner, [key('a')]);
    const restored = rollback.drafts[0]!.attachments[0]!;
    assert.equal(restored.type, 'approval');
    if (restored.type === 'approval') assert.equal(recovery.snapshot({ ...owner, sessionId: 'a' }, restored.approvalId).content.byteLength, 45 * 1024 * 1024);
    store.releaseSnapshot(owner.senderId, rollback);
  }
});

test('snapshot release includes side-conversation approvals and remains sender-scoped', async (t) => {
  const { store, recovery } = fixture(t);
  const ordinary = recovery.issue({ ...owner, sessionId: 'a' }, [{ name: 'a', mimeType: 'text/plain', content: Uint8Array.of(1) }])[0]!;
  const side = recovery.issue({ ...owner, sessionId: 'side' }, [{ name: 'side', mimeType: 'text/plain', content: Uint8Array.of(2) }])[0]!;
  const state = { ...snapshot({ ...emptyDraft(), attachments: [{ type: 'approval' as const, ...ordinary }] }), sideConversations: [{
    panel: { id: 'panel', sourceSessionId: key('a'), quotes: [] }, active: true, hasContent: true,
    draft: { ...emptyDraft('side'), attachments: [{ type: 'approval' as const, ...side }] },
  }] };
  store.releaseSnapshot(22, state);
  assert.equal(recovery.snapshot({ ...owner, sessionId: 'side' }, side.approvalId).content[0], 2);
  store.releaseSnapshot(owner.senderId, state);
  for (const [sessionId, approval] of [['a', ordinary], ['side', side]] as const)
    assert.throws(() => recovery.snapshot({ ...owner, sessionId }, approval.approvalId), { code: 'source_expired' });
});

test('more than 256 visited sessions preserve both empty and nonempty drafts', async (t) => {
  const { store } = fixture(t);
  const drafts = Array.from({ length: 257 }, (_, index) => ({ ...emptyDraft(String(index)), text: index % 2 ? `draft ${index}` : '' }));
  await store.save(owner, snapshot(...drafts));
  assert.deepEqual(store.load(owner, drafts.map((draft) => draft.sessionId)).drafts, drafts);
});

test('a workspace can save three independently valid 45 MiB drafts together', async (t) => {
  const { dir, store, approvals } = fixture(t);
  const path = join(dir, 'large-draft.bin');
  writeFileSync(path, new Uint8Array(45 * 1024 * 1024));
  const drafts = ['a', 'b', 'c'].map((id) => ({ ...emptyDraft(id), attachments: [{ type: 'approval' as const,
    ...approvals.issueApprovals(owner.senderId, [{ path, name: `${id}.bin`, size: 45 * 1024 * 1024 }])[0]!,
  }] }));
  await store.save(owner, snapshot(...drafts));
  for (const draft of drafts) {
    const restored = store.load(owner, [draft.sessionId]);
    const attachment = restored.drafts[0]!.attachments[0]!;
    assert.equal(attachment.type, 'approval');
    if (attachment.type === 'approval') assert.equal(attachment.size, 45 * 1024 * 1024);
    store.releaseSnapshot(owner.senderId, restored);
  }
});

test('an exact draft owner can keep already-custodied bytes after source token expiry without reading its path again', async (t) => {
  let now = 0;
  const { dir, store, approvals, recovery } = fixture(t, () => now);
  const path = join(dir, 'long-lived.txt');
  writeFileSync(path, 'original');
  const picked = approvals.issueApprovals(owner.senderId, [{ path, name: 'long-lived.txt', size: 8 }])[0]!;
  const recovered = recovery.issue({ ...owner, sessionId: 'a' }, [{ name: 'recovered.txt', mimeType: 'text/plain', content: Buffer.from('recovered') }])[0]!;
  const draft = { ...emptyDraft(), attachments: [{ type: 'approval' as const, ...picked }, { type: 'approval' as const, ...recovered }] };
  await store.save(owner, snapshot(draft));
  rmSync(path);
  now = 31 * 60 * 1000;
  assert.equal(approvals.peekApproval(owner.senderId, picked.approvalId), null);
  assert.throws(() => recovery.snapshot({ ...owner, sessionId: 'a' }, recovered.approvalId), { code: 'source_expired' });
  for (const other of [
    { ...owner, senderId: 22 }, { ...owner, partition: 'other' },
    { ...owner, scope: { ...owner.scope, targetEpoch: 'other' } },
  ]) await assert.rejects(store.save(other, snapshot(draft)), { code: 'source_expired' });
  await assert.rejects(store.save(owner, snapshot({ ...draft, sessionId: key('b') })), { code: 'source_expired' });
  await store.save(owner, snapshot({ ...draft, text: 'edited after expiry' }));
  const target = { ...owner, senderId: 22 };
  const loaded = store.load(target, [key('a')]);
  assert.equal(loaded.drafts[0]!.text, 'edited after expiry');
  const prepared = recovery.prepare({ ...target, sessionId: 'a' }, loaded.drafts[0]!.attachments);
  assert.deepEqual(prepared.items.map((item) => Buffer.from((item as { base64: string }).base64, 'base64').toString()), ['original', 'recovered']);
  prepared.dispose();
  await store.save(owner, snapshot(emptyDraft()));
  await assert.rejects(store.save(owner, snapshot(draft)), { code: 'source_expired' }, 'removed attachments cannot be resurrected by their former custody');
});

test('only an authorized recovery owner can place bytes in a workspace', async (t) => {
  const { store, recovery } = fixture(t);
  const issued = recovery.issue({ ...owner, sessionId: 'a' }, [{ name: 'private', mimeType: 'text/plain', content: Uint8Array.of(1) }])[0]!;
  const draft = { ...emptyDraft(), attachments: [{ type: 'approval' as const, ...issued }] };
  for (const other of [
    { ...owner, senderId: 22 },
    { ...owner, partition: 'other' },
    { ...owner, scope: { ...owner.scope, targetEpoch: 'other' } },
  ]) await assert.rejects(store.save(other, snapshot(draft)));
  await assert.rejects(store.save(owner, snapshot({ ...draft, sessionId: key('b') })));
  await store.save(owner, snapshot(draft));
  assert.equal(store.load({ ...owner, senderId: 22 }, [key('a')]).drafts[0]!.attachments.length, 1);
});

test('side conversations keep their panel, fork, own-turn boundary and draft', async (t) => {
  const { store } = fixture(t);
  const state: SessionWorkspaceSnapshot = {
    ...snapshot(emptyDraft()), sideConversations: [{
      panel: { id: 'panel', sourceSessionId: key('a'), quotes: [{ id: 'quote', value: { text: 'question' } }] },
      active: true, hasContent: true,
      companion: { sessionId: key('side'), ownTurnIds: ['own-turn'], queueOwnedMessageIds: ['queued-message'] },
      draft: { ...emptyDraft('side'), text: 'follow-up question' },
    }],
  };
  await store.save(owner, state);
  assert.deepEqual(store.load({ ...owner, senderId: 22 }, [key('a')]).sideConversations, state.sideConversations);
  await store.save(owner, { ...snapshot(emptyDraft()), capturedAt: state.capturedAt + 1 });
  assert.deepEqual(store.load(owner, [key('a')]).sideConversations, []);
});

test('a stale checkpoint cannot overwrite a newer final snapshot', async (t) => {
  const { store } = fixture(t);
  await store.save(owner, { ...snapshot({ ...emptyDraft(), text: 'final' }), capturedAt: 20 });
  await store.save(owner, { ...snapshot({ ...emptyDraft(), text: 'older checkpoint' }), capturedAt: 10 });
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, 'final');
});

test('revocation blocks already queued saves and clears only the revoked partition', async (t) => {
  const { store } = fixture(t);
  await store.save({ ...owner, partition: 'other' }, snapshot({ ...emptyDraft(), text: 'other authority' }));
  const pending = store.save(owner, snapshot({ ...emptyDraft(), text: 'queued before revoke' }));
  store.clear(owner.partition);
  await assert.rejects(pending, /authorization was cleared/);
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, '');
  assert.equal(store.load({ ...owner, partition: 'other' }, [key('a')]).drafts[0]!.text, 'other authority');
});


test('confirmed deletion ignores pending and late checkpoints without blocking unrelated draft saves', async (t) => {
  const { store } = fixture(t);
  await store.save(owner, snapshot({ ...emptyDraft(), text: 'before deletion' }));
  const saving = store.save(owner, snapshot({ ...emptyDraft(), text: 'pending' }, { ...emptyDraft('b'), text: 'B stays' }));
  store.delete(owner.partition, [key('a')]);
  await saving;
  await store.save(owner, snapshot({ ...emptyDraft(), text: 'late source checkpoint' }));
  const loaded = store.load(owner, [key('a'), key('b')]);
  assert.equal(loaded.drafts[0]!.text, '');
  assert.equal(loaded.drafts[1]!.text, 'B stays');
});

test('deletion during a picker read ignores its revoked approval and still saves other sessions', async (t) => {
  const { dir, store, approvals } = fixture(t);
  const path = join(dir, 'pending.txt');
  writeFileSync(path, 'pending');
  const picked = approvals.issueApprovals(owner.senderId, [{ path, name: 'pending.txt', size: 7 }])[0]!;
  const peek = approvals.peekApproval;
  let deleted = false;
  approvals.peekApproval = (senderId, approvalId) => {
    const approved = peek(senderId, approvalId);
    if (!deleted) {
      deleted = true;
      store.delete(owner.partition, [key('a')]);
      approvals.clearSender(owner.senderId);
    }
    return approved;
  };
  await store.save(owner, snapshot({ ...emptyDraft(), attachments: [{ type: 'approval', ...picked }] }, { ...emptyDraft('b'), text: 'unrelated draft' }));
  const loaded = store.load(owner, [key('a'), key('b')]);
  assert.ok(deleted);
  assert.equal(loaded.drafts[0]!.attachments.length, 0);
  assert.equal(loaded.drafts[1]!.text, 'unrelated draft');
});
