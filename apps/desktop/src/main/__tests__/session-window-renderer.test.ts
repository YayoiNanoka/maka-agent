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
import test from 'node:test';
import { createAppShellSessionUiStateController, createConversationWorkspace, stubConversationServices, replaceWorkspaceReadingAnchors } from '../../renderer/features/conversation/testing.js';
import { bootstrapSessionWindow, createSessionWindowCommandHandler, createSessionWindowNavigator, restoreSessionWindowWorkspace } from '../../renderer/features/session-windows/testing.js';
import { createDesktopSessionWindowServices } from '../../renderer/platform/desktop/create-session-window-services.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { clearNewTaskReloadIntent, markNewTaskReloadIntent } from '../../renderer/application/contracts/new-task-reload-intent.js';
import type { SessionWindowNavigation } from '../../shared/session-window-contract.js';
import type { SessionWorkspaceSnapshot } from '../../shared/session-workspace-state.js';

const group = { hostId: 'host', groupId: 'A', sessionIds: ['A', 'child'] };
const snapshot: SessionWorkspaceSnapshot = { capturedAt: 1, drafts: [], sideConversations: [] };
function harness(selected = 'A') {
  let active: string | undefined = selected;
  const events: string[] = [];
  const handler = createSessionWindowCommandHandler({
    freeze: (value) => { events.push(value ? 'freeze' : 'resume'); },
    activeSessionId: () => active,
    sessionIds: () => ['A', 'B'],
    capture: async (ids) => { events.push(`capture:${ids.join(',')}`); return snapshot; },
    clear: (ids, selection) => { events.push(`clear:${ids.join(',')}`); if (selection) active = undefined; },
    restore: () => { events.push('restore'); },
    navigate: async ({ sessionId }) => { events.push(`navigate:${sessionId}`); active = sessionId; },
    save: async () => { events.push('save'); },
    detach: () => { events.push('detach'); },
    resume: () => { events.push('resume-resources'); },
  });
  return { handler, events, active: () => active };
}

test('clearing A releases its displayed child but preserves an unrelated B selection', async () => {
  for (const selected of ['A', 'child', 'B']) {
    const state = harness(selected);
    await state.handler({ requestId: 'clear', kind: 'clear', group });
    assert.equal(state.active(), selected === 'B' ? 'B' : undefined);
  }
});

test('handoff freezes before capturing and target restore preserves B before installing A', async () => {
  const state = harness('B');
  const prepared = await state.handler({ requestId: 'prepare', kind: 'prepare-transfer', group });
  assert.deepEqual(state.events, ['freeze', 'capture:A,child']);
  assert.equal(prepared?.activeSessionId, 'B');
  state.events.length = 0;
  await state.handler({ requestId: 'restore', kind: 'restore', group, navigation: { sessionId: 'child' }, snapshot });
  assert.deepEqual(state.events, ['capture:A,B', 'save', 'restore', 'navigate:child', 'resume']);
  assert.equal(state.active(), 'child');
});

test('close flush confirms saving before detaching resources', async () => {
  const state = harness();
  await state.handler({ requestId: 'flush', kind: 'flush' });
  assert.deepEqual(state.events, ['freeze', 'capture:A,B', 'save', 'detach']);
});

test('a failed close save resumes the source without detaching or discarding it', async () => {
  const events: string[] = [];
  const handler = createSessionWindowCommandHandler({
    freeze: (value) => { events.push(value ? 'freeze' : 'thaw'); }, activeSessionId: () => 'A', sessionIds: () => ['A'],
    capture: async () => snapshot, clear: () => { throw new Error('unexpected clear'); }, restore: () => undefined,
    navigate: async () => undefined, save: async () => { throw new Error('disk full'); },
    detach: () => { events.push('detach'); }, resume: () => { events.push('resume'); },
  });
  await assert.rejects(handler({ requestId: 'flush', kind: 'flush' }), /disk full/);
  assert.deepEqual(events, ['freeze', 'resume', 'thaw']);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('an owned task routes to its other window without restoring or mounting locally', async () => {
  const calls: string[] = [];
  const open = createSessionWindowNavigator({ route: async () => 'routed', restore: async () => { calls.push('restore'); }, blocked: () => false });
  await open.open({ sessionId: 'A' }, () => { calls.push('activate'); });
  assert.deepEqual(calls, []);
});

test('local navigation restores the saved workspace before selecting the task', async () => {
  const calls: string[] = [];
  const open = createSessionWindowNavigator({ route: async () => 'local', restore: async () => { calls.push('restore'); }, blocked: () => false });
  await open.open({ sessionId: 'A' }, () => { calls.push('activate'); });
  assert.deepEqual(calls, ['restore', 'activate']);
});

test('a superseded route and a route arriving during handoff cannot replace the current task', async () => {
  const first = deferred<'local'>();
  let blocked = false;
  const selected: string[] = [];
  const open = createSessionWindowNavigator({ route: (nav: SessionWindowNavigation) => nav.sessionId === 'A' ? first.promise : Promise.resolve('local'), restore: async () => undefined, blocked: () => blocked });
  const old = open.open({ sessionId: 'A' }, () => { selected.push('A'); });
  await open.open({ sessionId: 'B' }, () => { selected.push('B'); });
  first.resolve('local');
  await old;
  assert.deepEqual(selected, ['B']);
  const restoring = deferred<void>();
  const during = createSessionWindowNavigator({ route: async () => 'local', restore: () => restoring.promise, blocked: () => blocked });
  const pending = during.open({ sessionId: 'A' }, () => { selected.push('A'); });
  await Promise.resolve();
  blocked = true;
  restoring.resolve();
  await pending;
  assert.deepEqual(selected, ['B']);
});

test('returning a task that follows latest clears its old main-window anchor and preserves B', () => {
  const ui = createAppShellSessionUiStateController();
  ui.setTranscriptReadingAnchor('A', { turnId: 'old-main-anchor' });
  ui.setTranscriptReadingAnchor('B', { turnId: 'B-anchor' });
  // The child scrolled to the tail; absent A is intentional, not a partial patch.
  replaceWorkspaceReadingAnchors(['A', 'child'], { child: { turnId: 'child-anchor' } }, ui.setTranscriptReadingAnchor);
  assert.equal(ui.transcriptReadingAnchorBySessionRef.current.A, undefined);
  assert.deepEqual(ui.transcriptReadingAnchorBySessionRef.current.child, { turnId: 'child-anchor' });
  assert.deepEqual(ui.transcriptReadingAnchorBySessionRef.current.B, { turnId: 'B-anchor' });
  // Source clear and confirmed deletion use the same scoped replacement.
  replaceWorkspaceReadingAnchors(['A', 'child'], {}, ui.setTranscriptReadingAnchor);
  assert.equal(ui.transcriptReadingAnchorBySessionRef.current.child, undefined);
  assert.deepEqual(ui.transcriptReadingAnchorBySessionRef.current.B, { turnId: 'B-anchor' });
});

function readableSessions() {
  return ['A', 'B', 'child'].map((id) => ({
    id, name: id, isFlagged: false, isArchived: false, labels: [], lastMessageAt: 1,
    hasUnread: false, status: 'active' as const, backend: 'ai-sdk' as const,
    revision: 1, runtimeHostId: 'local', profileId: 'local', profileName: 'Local',
    llmConnectionSlug: 'test', connectionLocked: false, model: 'test',
    permissionMode: 'ask' as const, profileKind: 'local' as const,
  }));
}

test('releasing a pending task revokes late transcript publication while preserving the other displayed task', async () => {
  const catalog = createSessionCatalogController();
  catalog.commitSessions(readableSessions());
  const workspace = createConversationWorkspace(catalog, stubConversationServices().observation, false);
  workspace.commands.setActiveId('B');
  const b = [{ id: 'b-message', type: 'user' as const, text: 'B', ts: 1, turnId: 'b-turn' }];
  workspace.commitTranscript('B', b);
  workspace.commands.setActiveId('A');
  const ownsPendingA = workspace.commands.captureSelection();
  assert.equal(workspace.activeIdRef.current, 'B');
  const handler = createSessionWindowCommandHandler({
    freeze() {}, activeSessionId: () => workspace.activeIdRef.current, sessionIds: () => ['B'],
    capture: async () => snapshot, restore() {}, navigate: async () => {}, save: async () => {}, detach() {}, resume() {},
    clear: (ids) => { for (const id of ids) workspace.commands.clearOwnedSessionState(id); },
  });
  await handler({ requestId: 'release-a', kind: 'clear', group });
  assert.equal(ownsPendingA(), false);
  assert.equal(catalog.getState().activeSessionId, 'B');
  assert.equal(workspace.commitTranscript('A', [{ ...b[0]!, id: 'late-a', text: 'A' }]), false);
  assert.equal(workspace.activeIdRef.current, 'B');
  assert.deepEqual(workspace.messages.getSnapshot(), b);

  // Releasing the displayed member must also leave another requested task alive.
  workspace.commands.setActiveId('A');
  workspace.commitTranscript('A', []);
  workspace.commands.setActiveId('B');
  await handler({ requestId: 'release-displayed-a', kind: 'clear', group });
  assert.equal(catalog.getState().activeSessionId, 'B');
  assert.equal(workspace.commitTranscript('B', b), true);
});

test('a completed freeze/resume cycle invalidates both pending routes and pending workspace restores', async () => {
  for (const phase of ['route', 'restore'] as const) {
    const wait = deferred<void>();
    const effects: string[] = [];
    let blocked = false;
    const navigator = createSessionWindowNavigator({
      blocked: () => blocked,
      route: async () => { if (phase === 'route') await wait.promise; return 'local'; },
      restore: async (_id, isCurrent) => {
        if (phase === 'restore') await wait.promise;
        if (isCurrent()) effects.push('restored-A');
      },
    });
    const pending = navigator.open({ sessionId: 'A' }, () => { effects.push('selected-A'); });
    await Promise.resolve();
    blocked = true;
    navigator.invalidate();
    blocked = false;
    wait.resolve();
    await pending;
    assert.equal(effects.length, 0, phase);
    await navigator.open({ sessionId: 'B' }, () => { effects.push('selected-B'); });
    assert.equal(effects.at(-1), 'selected-B', 'new navigation still works after resume');
  }
});

test('a discarded workspace load releases main and side-chat recovery handles without populating draft caches', async () => {
  const draft = {
    sessionId: 'A', text: 'unsent', references: [], directoryReferences: [], quotes: [],
    attachments: [{ type: 'approval' as const, approvalId: 'local-recovery:main', name: 'a.png', size: 1 }],
  };
  const loaded: SessionWorkspaceSnapshot = {
    capturedAt: 1, drafts: [draft],
    sideConversations: [{ panel: { id: 'side', sourceSessionId: 'A', quotes: [] }, hasContent: true, active: true,
      draft: { ...draft, sessionId: 'side', attachments: [
        ...draft.attachments,
        { type: 'approval', approvalId: 'local-recovery:side', name: 'b.png', size: 1 },
        { type: 'upload', name: 'not-a-handle', mimeType: 'text/plain', base64: 'aGVsbG8=' },
      ] } }],
  };
  const released: (readonly string[])[] = [];
  const services = createDesktopSessionWindowServices({
    appWindow: {}, sessionLocal: { releaseRecoveryAttachments: async (ids: readonly string[]) => { released.push(ids); } },
  } as unknown as Parameters<typeof createDesktopSessionWindowServices>[0]);
  const ready = deferred<SessionWorkspaceSnapshot>();
  const restored = new Map<string, string>();
  const selected: string[] = [];
  const navigator = createSessionWindowNavigator({
    blocked: () => false, route: async () => 'local',
    restore: (_id, isCurrent) => restoreSessionWindowWorkspace({
      load: () => ready.promise, release: services.releaseSnapshot, isCurrent,
      restore: (state) => { for (const member of state.drafts) restored.set(member.sessionId, member.text); },
    }),
  });
  const pending = navigator.open({ sessionId: 'A' }, () => { selected.push('A'); });
  await Promise.resolve();
  navigator.invalidate();
  ready.resolve(loaded);
  await pending;
  assert.equal(restored.size, 0);
  assert.equal(selected.length, 0);
  assert.deepEqual(released, [['local-recovery:main', 'local-recovery:side']]);

  // A subsequent accepted load adopts the snapshot, retaining its handles.
  await navigator.open({ sessionId: 'A' }, () => { selected.push('A'); });
  assert.equal(restored.get('A'), 'unsent');
  assert.deepEqual(selected, ['A']);
  assert.equal(released.length, 1);
  await services.releaseSnapshot(snapshot);
  assert.equal(released.length, 1, 'empty snapshots do not send disposal IPC');
});

test('window bootstrap preserves an explicit new-task reload intent before and during catalog loading', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    const selected: string[] = [];
    const input = { kind: 'main' as const, refresh: async () => readableSessions(), revision: () => 0, open: (id: string) => { selected.push(id); } };
    markNewTaskReloadIntent();
    await bootstrapSessionWindow(input);
    assert.deepEqual(selected, []);
    clearNewTaskReloadIntent();
    const refresh = deferred<ReturnType<typeof readableSessions>>();
    const boot = bootstrapSessionWindow({ ...input, refresh: () => refresh.promise });
    markNewTaskReloadIntent();
    refresh.resolve(readableSessions());
    await boot;
    assert.deepEqual(selected, []);
    clearNewTaskReloadIntent();
    await bootstrapSessionWindow(input);
    assert.deepEqual(selected, ['A'], 'cold main windows still select history');
    await bootstrapSessionWindow({ ...input, kind: 'session' });
    assert.deepEqual(selected, ['A'], 'session windows never choose recent history');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
