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

import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { act, useState, type ComponentProps } from 'react';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComposerHandle } from '@maka/ui';
import type { SessionWorkspaceSnapshot } from '../../shared/session-workspace-state.js';
import { SessionWindowBinding, SessionWindowServicesProvider, type SessionWindowServices } from '../../renderer/features/session-windows/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

type BindingProps = ComponentProps<typeof SessionWindowBinding>;

const saved: SessionWorkspaceSnapshot = {
  capturedAt: 1,
  drafts: [{
    sessionId: 'a', text: 'important unsent draft', references: [],
    attachments: [{ type: 'approval', approvalId: 'local-recovery:handoff', name: 'draft.txt', size: 5 }],
    directoryReferences: [], quotes: [],
  }],
  sideConversations: [],
};

async function mountBinding(options: {
  load?(): Promise<void>;
  refresh?(): Promise<void>;
  adopt?(): Promise<void>;
  snapshot?: SessionWorkspaceSnapshot;
  initialSessionId?: string;
} = {}) {
  const { root } = installReactRenderer();
  globalThis.requestAnimationFrame = (callback) => { queueMicrotask(() => callback(0)); return 1; };
  const lifecycle: BindingProps['window']['lifecycle'] = {};
  const state = {
    active: (options.initialSessionId ?? 'b') as string | undefined,
    restoring: false,
    loads: 0,
    clearSelections: 0,
    restored: [] as Parameters<ComposerHandle['restoreDrafts']>[0][number][],
    staged: [] as Parameters<BindingProps['staging']['replaceDrafts']>[0][number][],
    released: [] as SessionWorkspaceSnapshot[],
    adopted: [] as SessionWorkspaceSnapshot[],
  };
  let select: (id: string | undefined) => void = () => { throw new Error('Binding is not mounted'); };
  const services: SessionWindowServices = {
    context: async () => ({ kind: 'main', windowId: 'main' }),
    routeSession: async () => 'local',
    openSessionWindow: async () => {},
    openInMainWindow: async () => {},
    sessionWindowReady: async () => {},
    subscribeSessionWindowCommand: () => () => {},
    ackSessionWindowCommand: async () => {},
    loadWorkspaceSnapshot: async (ids) => {
      assert.deepEqual(ids, ['a']);
      state.loads += 1;
      await options.load?.();
      return options.snapshot ?? saved;
    },
    adoptWorkspaceSnapshot: async (snapshot) => {
      await options.adopt?.();
      state.adopted.push(snapshot);
    },
    releaseSnapshot: async (snapshot) => { state.released.push(snapshot); },
    commandMain: async () => {},
    subscribeDeleted: () => () => {},
  };
  const composer: ComposerHandle = {
    waitForDraftReady: async () => {},
    captureDrafts: () => [],
    restoreDrafts: (drafts) => {
      assert.equal(state.active, 'a', 'restore happens after selecting the destination');
      state.restored.push(...drafts);
    },
    setText() {}, appendText() {}, getText: () => '', clearDraft() {}, setDraft() {},
    getDraft: () => '', captureEmptyDraft: () => undefined, appendDraft() {}, focus() {}, openModelPicker() {},
  };
  const staging: BindingProps['staging'] = {
    flushImports: async () => {}, captureDrafts: () => [], clearDrafts() {},
    replaceDrafts: (drafts) => { state.staged.push(...drafts); },
  };
  const submission: BindingProps['submission'] = {
    waitForPendingSends: async () => {}, captureWorkspace: () => ({ retractedReferences: {} }),
    restoreWorkspace() {}, clearWorkspace() {},
  };
  const conversation: BindingProps['conversation'] = {
    composer: { current: composer },
    readActiveSessionId: () => state.active,
    clearSelection: () => { state.clearSelections += 1; select(undefined); },
    clearOwnedSessionState() {}, captureReadingAnchors: () => ({}), restoreReadingAnchors() {},
  };
  function Harness() {
    const [active, setActive] = useState<string | undefined>(options.initialSessionId ?? 'b');
    const [restoring, setRestoring] = useState(false);
    select = setActive;
    state.active = active;
    state.restoring = restoring;
    const window: BindingProps['window'] = {
      context: { kind: 'main', windowId: 'main' }, lifecycle,
      frozen: restoring, returning: false, standalone: false,
      setFrozen() {}, setRestoring,
      bootstrap: async () => {}, openSession: async () => true, openInNewWindow: async () => {},
      openInMainWindow() {}, commandMain() {},
    };
    return <SessionWindowServicesProvider value={services}>
      <SessionWindowBinding window={window} staging={staging} submission={submission}
        workbar={{ captureWorkspace: () => ({}), restoreWorkspace() {} }}
        conversation={conversation} activeSessionId={active}
        openLocal={({ sessionId }) => select(sessionId)} clearLocal={() => select(undefined)}
        refreshSessions={async () => {}}
        refreshMessages={async () => { await options.refresh?.(); return true; }} />
    </SessionWindowServicesProvider>;
  }
  await act(async () => root.render(<Harness />));
  assert.ok(lifecycle.current);
  return {
    state, select: (id: string) => select(id),
    open: (isCurrent = () => true, activate = () => select('a')) => lifecycle.current!.openWorkspace('a', isCurrent, activate),
  };
}

afterEach(cleanupFakeDom);

test('cancelled activation stays unvisited so reopening reloads and adopts the saved draft', async () => {
  const refreshStarted = deferred();
  const refresh = deferred();
  let waitForRefresh = true;
  const binding = await mountBinding({ refresh: async () => {
    refreshStarted.resolve();
    if (waitForRefresh) await refresh.promise;
  } });
  let current = true;
  let opening!: Promise<void>;
  await act(async () => {
    opening = binding.open(() => current);
    await refreshStarted.promise;
  });
  assert.equal(binding.state.active, 'a');
  assert.equal(binding.state.restoring, true);
  await act(async () => {
    current = false;
    binding.select('b');
    refresh.resolve();
    await opening;
  });
  assert.equal(binding.state.restoring, false);
  assert.deepEqual(binding.state.released, [saved]);
  assert.equal(binding.state.restored.length, 0);
  assert.equal(binding.state.adopted.length, 0);
  waitForRefresh = false;
  await act(async () => { await binding.open(); });
  assert.equal(binding.state.loads, 2, 'cancelled selection must not mark the Session as visited');
  assert.equal(binding.state.restored[0]!.text, saved.drafts[0]!.text);
  assert.deepEqual(binding.state.staged[0]!.context.stagedAttachments, [{
    approvalId: 'local-recovery:handoff', name: 'draft.txt', mimeType: undefined, size: 5,
  }]);
  assert.deepEqual(binding.state.adopted, [saved]);
  assert.equal(binding.state.clearSelections, 2, 'a saved handoff resets the previous selection before each attempt');
  await act(async () => { binding.select('b'); });
  await act(async () => { await binding.open(); });
  assert.equal(binding.state.loads, 2, 'successfully adopted drafts use ordinary local navigation');
});

test('restoration freezes the surface while loading, activating, and adopting the draft', async () => {
  const load = deferred();
  const refreshStarted = deferred();
  const refresh = deferred();
  const adoptStarted = deferred();
  const adopt = deferred();
  const binding = await mountBinding({
    load: () => load.promise,
    refresh: () => { refreshStarted.resolve(); return refresh.promise; },
    adopt: () => { adoptStarted.resolve(); return adopt.promise; },
  });
  let opening!: Promise<void>;
  await act(async () => { opening = binding.open(); });
  assert.equal(binding.state.restoring, true);
  assert.equal(binding.state.active, 'b');
  await act(async () => { load.resolve(); await refreshStarted.promise; });
  assert.equal(binding.state.restoring, true);
  assert.equal(binding.state.active, 'a');
  assert.equal(binding.state.restored.length, 0);
  await act(async () => { refresh.resolve(); await adoptStarted.promise; });
  assert.equal(binding.state.restoring, true);
  assert.equal(binding.state.restored[0]!.text, saved.drafts[0]!.text);
  await act(async () => { adopt.resolve(); await opening; });
  assert.equal(binding.state.restoring, false);
  assert.deepEqual(binding.state.adopted, [saved]);
});

test('activation failure releases temporary attachment handles and allows retry', async () => {
  const binding = await mountBinding();
  await act(async () => {
    await assert.rejects(binding.open(() => true, () => { throw new Error('activation failed'); }), /activation failed/);
  });
  assert.equal(binding.state.restoring, false);
  assert.deepEqual(binding.state.released, [saved]);
  assert.equal(binding.state.restored.length, 0);
  assert.equal(binding.state.adopted.length, 0);
  await act(async () => { await binding.open(); });
  assert.equal(binding.state.loads, 2);
  assert.equal(binding.state.restored[0]!.text, saved.drafts[0]!.text);
  assert.deepEqual(binding.state.adopted, [saved]);
});


test('opening a Session without a handoff snapshot keeps ordinary selection behavior', async () => {
  const empty: SessionWorkspaceSnapshot = { capturedAt: 0, drafts: [], sideConversations: [] };
  const binding = await mountBinding({ snapshot: empty });
  await act(async () => { await binding.open(); });
  assert.equal(binding.state.active, 'a');
  assert.equal(binding.state.clearSelections, 0);
  assert.equal(binding.state.restored.length, 0);
  assert.deepEqual(binding.state.adopted, [empty]);
});

test('an already active Session keeps its local draft without loading a handoff', async () => {
  const binding = await mountBinding({ initialSessionId: 'a' });
  await act(async () => { await binding.open(); });
  assert.equal(binding.state.active, 'a');
  assert.equal(binding.state.loads, 0);
  assert.equal(binding.state.clearSelections, 0);
  assert.equal(binding.state.restoring, false);
  assert.equal(binding.state.restored.length, 0);
  assert.equal(binding.state.adopted.length, 0);
});
