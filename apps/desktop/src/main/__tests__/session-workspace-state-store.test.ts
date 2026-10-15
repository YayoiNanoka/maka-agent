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
import { createSessionCopyCleanupAuthority } from '@maka/storage/session-copy-cleanup';
import { adoptWorkspaceCopies } from '../session-workspace-custody.js';
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
  const store = new SessionWorkspaceStateStore({ approvals, recovery });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, approvals, recovery };
}

test('hands off the complete group without replacing another session or crossing authority boundaries', async (t) => {
  const { store } = fixture(t);
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
  const loaded = store.load({ ...owner, senderId: 22 }, [key('a'), key('child')]);
  assert.deepEqual(loaded.drafts, [a, { ...emptyDraft('child'), text: 'child draft' }]);
  assert.deepEqual(loaded.readingAnchors, { [key('a')]: { turnId: 'turn-1' } });
  assert.equal(store.load(owner, [key('unrelated')]).drafts[0]!.text, 'keep me');
  assert.equal(store.load({ ...owner, partition: 'different-authority' }, [key('a')]).drafts[0]!.text, '');
  assert.throws(() => store.load({ ...owner, scope: { ...owner.scope, hostId: 'other-host' } }, [key('a')]), /different Host/);
});

test('a new process-lifetime store starts empty and shutdown invalidates pending handoffs', async (t) => {
  const { store, approvals, recovery } = fixture(t);
  await store.save(owner, {
    ...snapshot({ ...emptyDraft(), text: 'only for this app lifetime', attachments: [{ type: 'upload', name: 'draft.txt', mimeType: 'text/plain', base64: Buffer.from('draft bytes').toString('base64') }] }),
    readingAnchors: { [key('a')]: { turnId: 'turn-1' } },
  });
  const pending = store.save(owner, snapshot({ ...emptyDraft(), text: 'closing' }));
  store.close();
  await assert.rejects(pending, /authorization was cleared/);
  await assert.rejects(store.save(owner, snapshot(emptyDraft())), /store is closed/);
  const restarted = new SessionWorkspaceStateStore({ approvals, recovery });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.load(owner, [key('a')]), {
    capturedAt: 0, drafts: [emptyDraft()], sideConversations: [], workbar: {}, readingAnchors: {},
  });
});

test('destination edits do not mutate the snapshot needed for transfer rollback', async (t) => {
  const { store } = fixture(t);
  const draft = { ...emptyDraft(), text: 'original', quotes: [{ text: 'quoted text' }] };
  await store.save(owner, { ...snapshot(draft), readingAnchors: { [key('a')]: { turnId: 'turn-1' } } });
  const destination = store.load({ ...owner, senderId: 22 }, [key('a')]);
  Object.assign(destination.drafts[0]!.quotes[0]!, { text: 'changed' });
  Object.assign(destination.readingAnchors![key('a')]!, { turnId: 'changed' });
  assert.deepEqual(store.load(owner, [key('a')]).drafts, [draft]);
  assert.deepEqual(store.load(owner, [key('a')]).readingAnchors, { [key('a')]: { turnId: 'turn-1' } });
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
  assert.ok(approvals.peekApproval(owner.senderId, picked.approvalId), 'preparing a handoff does not consume a picker approval');
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

test('a handoff snapshot does not extend source approval or recovery token lifetime', async (t) => {
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
  await assert.rejects(store.save(owner, snapshot({ ...draft, text: 'edited after expiry' })), { code: 'source_expired' });
  const target = { ...owner, senderId: 22 };
  const loaded = store.load(target, [key('a')]);
  assert.equal(loaded.drafts[0]!.text, '', 'failed preparation preserves the last transferable snapshot');
  const prepared = recovery.prepare({ ...target, sessionId: 'a' }, loaded.drafts[0]!.attachments);
  assert.deepEqual(prepared.items.map((item) => Buffer.from((item as { base64: string }).base64, 'base64').toString()), ['original', 'recovered']);
  prepared.dispose();
  store.forget(owner.partition, [key('a')], loaded.capturedAt);
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.attachments.length, 0);
  await assert.rejects(store.save(owner, snapshot(draft)), { code: 'source_expired' }, 'adoption does not retain a second attachment recovery path');
});

test('adoption forgets transferred state while preserving newer captures and future handoffs', async (t) => {
  const { store } = fixture(t);
  await store.save(owner, { ...snapshot({ ...emptyDraft(), text: 'older' }), capturedAt: 10 });
  const earlier = store.load({ ...owner, senderId: 22 }, [key('a')]);
  await store.save(owner, { ...snapshot({ ...emptyDraft(), text: 'newer' }), capturedAt: 20 });
  store.forget(owner.partition, [key('a')], earlier.capturedAt);
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, 'newer');
  store.forget(owner.partition, [key('a')], 20);
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, '');
  await store.save(owner, { ...snapshot({ ...emptyDraft(), text: 'next handoff' }), capturedAt: 30 });
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, 'next handoff', 'adoption is not session deletion');
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

test('a failed multi-Host window capture releases earlier partitions instead of replaying stale drafts', async (t) => {
  const { store } = fixture(t);
  const other = { senderId: owner.senderId, partition: 'authority-b', scope: { hostId: 'host-b', targetEpoch: 'epoch-b' } };
  const otherKey = desktopSessionKey({ hostId: 'host-b', sessionId: 'b' });
  const first = snapshot({ ...emptyDraft(), text: 'still owned by the renderer' });
  const invalid = snapshot({ ...emptyDraft(), sessionId: otherKey, attachments: [{ type: 'approval', approvalId: 'expired', name: 'draft.txt', size: 1 }] });
  await store.save(owner, snapshot({ ...emptyDraft('unrelated'), text: 'closed window keeps this' }));
  await assert.rejects(store.saveAll([{ owner, snapshot: first }, { owner: other, snapshot: invalid }]));
  assert.equal(store.load(owner, [key('a')]).drafts[0]!.text, '');
  assert.equal(store.load(owner, [key('unrelated')]).drafts[0]!.text, 'closed window keeps this');
  assert.equal(store.load(other, [otherKey]).drafts[0]!.text, '');
});


test('ordinary close retains text and valid attachments while reporting each expired or missing source', async (t) => {
  let now = 0;
  const { store, approvals, dir, recovery } = fixture(t, () => now);
  const expired = approvals.issueApprovals(owner.senderId, [{ path: join(dir, 'expired.txt'), name: 'expired.txt', size: 1 }])[0]!;
  now = 31 * 60 * 1000;
  const missing = approvals.issueApprovals(owner.senderId, [{ path: join(dir, 'missing.txt'), name: 'missing.txt', size: 1 }])[0]!;
  const valid = recovery.issue({ ...owner, sessionId: 'a' }, [{ name: 'valid.txt', mimeType: 'text/plain', content: Buffer.from('valid') }])[0]!;
  const state = snapshot({ ...emptyDraft(), text: 'keep unsent text', attachments: [
    { type: 'approval', ...expired }, { type: 'approval', ...missing }, { type: 'approval', ...valid },
  ] });
  await assert.rejects(store.save(owner, state));
  const losses: string[] = [];
  await store.save(owner, state, (loss) => losses.push(loss));
  const restored = store.load({ ...owner, senderId: 22 }, [key('a')]);
  assert.equal(restored.drafts[0]!.text, 'keep unsent text');
  assert.equal(restored.drafts[0]!.attachments.length, 1);
  assert.equal((restored.drafts[0]!.attachments[0] as { name: string }).name, 'valid.txt');
  assert.equal(losses.length, 2);
  assert.match(losses[0]!, /expired.txt/);
  assert.match(losses[1]!, /missing.txt/);
  assert.equal(state.drafts[0]!.attachments.length, 3, 'cancel leaves the original renderer contents intact');
});


for (const closing of [false, true]) {
  test(`${closing ? 'close retains valid state' : 'handoff rolls back custody'} when the second side conversation cannot be adopted`, async (t) => {
    const { store, dir } = fixture(t);
    const removed: string[] = [];
    const authority = createSessionCopyCleanupAuthority({ workspaceRoot: dir, removeSession: async (id) => { removed.push(id); } });
    for (const id of ['fork-a', 'fork-b']) await authority.ownCreation({ sessionId: id, sourceSessionId: 'a', kind: 'branch',
      intent: 'side_conversation', ownerId: 'web-contents:11' }, async () => {});
    await authority.cleanup('fork-b');
    removed.length = 0;
    const state: SessionWorkspaceSnapshot = {
      ...snapshot({ ...emptyDraft(), text: 'Unsent A' }),
      sideConversations: ['fork-a', 'fork-b'].map((id) => ({
        panel: { id, sourceSessionId: key('a'), quotes: [] }, hasContent: true, active: false,
        companion: { sessionId: key(id), ownTurnIds: [], queueOwnedMessageIds: [] },
        draft: { ...emptyDraft(id), text: `Unsent ${id}` },
      })),
    };
    const resolve = (side: SessionWorkspaceSnapshot['sideConversations'][number]) => ({ authority, sourceSessionId: 'a', sessionId: side.panel.id });
    await store.save(owner, state);
    const losses: string[] = [];
    const transfer = adoptWorkspaceCopies(state, {
      ownerId: 'workspace', previousOwnerId: 'web-contents:11', resolve,
      ...(closing ? { unavailable: (side: SessionWorkspaceSnapshot['sideConversations'][number]) => {
        losses.push(side.panel.id);
        store.releaseUnavailableCompanion(owner.partition, side.panel.sourceSessionId, side.panel.id, state.capturedAt);
      } } : {}),
    });
    if (!closing) {
      await assert.rejects(transfer, /no longer available/);
      store.forget(owner.partition, [key('a')], state.capturedAt);
      await authority.abandonOwner('web-contents:11');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(removed, ['fork-a'], 'failed handoff restores cleanup to the source');
      assert.equal(state.drafts[0]!.text, 'Unsent A');
      return;
    }
    await transfer;
    await authority.abandonOwner('web-contents:11');
    assert.deepEqual(removed, [], 'valid copy remains with the retained workspace');
    assert.deepEqual(losses, ['fork-b']);
    const restored = store.load({ ...owner, senderId: 22 }, [key('a')]);
    assert.equal(restored.drafts[0]!.text, 'Unsent A');
    assert.equal(restored.sideConversations[0]!.companion?.sessionId, key('fork-a'));
    assert.equal(restored.sideConversations[1]!.companion, undefined);
    assert.equal(restored.sideConversations[1]!.draft.text, 'Unsent fork-b');
    assert.equal(restored.sideConversations[1]!.draft.sessionId, key('a'));
    await adoptWorkspaceCopies(restored, { ownerId: 'web-contents:22', previousOwnerId: 'workspace', resolve });
    await authority.abandonOwner('web-contents:22');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(removed, ['fork-a']);
  });
}
