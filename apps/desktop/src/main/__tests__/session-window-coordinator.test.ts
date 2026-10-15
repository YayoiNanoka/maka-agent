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
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSessionWindowCoordinator, registerSessionWindowIpc } from '../session-window-coordinator.js';
import { createWorkspaceWindowRegistry } from '../workspace-window-registry.js';
import type { SessionWindowCommand, SessionWindowContext, SessionWindowGroup } from '../../shared/session-window-contract.js';
import type { SessionWorkspaceSnapshot } from '../../shared/session-workspace-state.js';

const snapshot = (): SessionWorkspaceSnapshot => ({ capturedAt: 1, drafts: [], sideConversations: [] });
const group: SessionWindowGroup = { hostId: 'local', groupId: 'A', sessionIds: ['A', 'A-child', 'A-version'] };

function harness() {
  const registry = createWorkspaceWindowRegistry();
  const mainCommands: string[] = [];
  let closeGate: { started(): void; wait: Promise<void> } | undefined;
  const commands: Array<{ windowId: string; command: SessionWindowCommand }> = [];
  const errors: unknown[] = [];
  const migrations: string[] = [];
  const saves: string[] = [];
  const loads: string[] = [];
  const released: string[] = [];
  const drafts = new Map<string, string>();
  let restoreGate: { started(): void; wait: Promise<void> } | undefined;
  const toSnapshot = (entries: readonly [string, string][]): SessionWorkspaceSnapshot => ({
    ...snapshot(), drafts: entries.map(([sessionId, text]) => ({ sessionId, text, references: [], attachments: [], directoryReferences: [], quotes: [] })),
  });
  let failRestore: 'main' | 'session' | undefined;
  let prepareWait: Promise<void> | undefined;
  let failSave = false;
  let failAdopt = false;
  let failConfirmation = false;
  let closeAnyway = false;
  const closeWarnings: readonly string[][] = [];
  let failLoad = false;
  let failRelease = false;
  let nextId = 0;
  let coordinator: ReturnType<typeof createSessionWindowCoordinator>;
  class FakeWindow extends EventEmitter {
    readonly id = String(++nextId);
    private readonly contents = Object.assign(new EventEmitter(), {
      id: Number(this.id),
      isDestroyed: () => this.destroyed,
      send: (channel: string, command: SessionWindowCommand) => {
        if (channel !== 'session-window:command') { mainCommands.push(channel); return; }
        commands.push({ windowId: this.id, command });
        queueMicrotask(async () => {
          if (command.kind === 'prepare-transfer' && prepareWait) await prepareWait;
          if (restoreGate && command.kind === 'restore' && this.context.kind === 'main') {
            const gate = restoreGate; restoreGate = undefined; gate.started(); await gate.wait;
          }
          const shouldFail = command.kind === 'restore' && this.context.kind === failRestore;
          if (shouldFail) failRestore = undefined;
          const captured = command.kind === 'prepare-transfer'
            ? toSnapshot([...this.drafts].filter(([id]) => command.group.sessionIds.includes(id)))
            : toSnapshot([...this.drafts]);
          const result = { snapshot: captured, activeSessionId: this.active };
          if (!shouldFail) {
            if (command.kind === 'clear') {
              for (const id of command.group.sessionIds) this.drafts.delete(id);
              if (command.group.sessionIds.includes(this.active ?? '')) this.active = undefined;
            } else if (command.kind === 'restore') {
              for (const draft of command.snapshot.drafts) this.drafts.set(draft.sessionId, draft.text);
              this.active = command.navigation.sessionId;
            } else if (command.kind === 'navigate') this.active = command.navigation.sessionId;
            else if (command.kind === 'resume' && command.navigation !== undefined) this.active = command.navigation?.sessionId;
          }
          coordinator.reply(this.contents as never, shouldFail
            ? { requestId: command.requestId, ok: false, error: 'restore failed' }
            : { requestId: command.requestId, ok: true, result });
        });
      },
    });
    get webContents() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    destroyed = false;
    focused = false;
    revealed = false;
    active: string | undefined = 'A';
    readonly drafts = new Map<string, string>();
    context: SessionWindowContext;
    constructor(context: Omit<Extract<SessionWindowContext, { kind: 'session' }>, 'windowId'> | { kind: 'main' }) {
      super();
      this.context = { ...context, windowId: this.id };
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }
  }
  const windows: FakeWindow[] = [];
  function add(context: Omit<Extract<SessionWindowContext, { kind: 'session' }>, 'windowId'> | { kind: 'main' }) {
    const window = new FakeWindow(context);
    const controller = {
      browserWindow: () => window,
      reveal: () => { window.revealed = true; },
      focus: () => { window.focused = true; },
    };
    registry.register({ context: window.context, window: window as never, controller: controller as never });
    windows.push(window);
    if (coordinator) coordinator.sessionWindowReady(window.webContents as never);
    return { window, controller };
  }
  const main = add({ kind: 'main' }).window;
  coordinator = createSessionWindowCoordinator({
    windows: { registry, createSessionWindow: async (context: any) => add(context).controller } as never,
    signal: new AbortController().signal,
    ensureMainWindow: async () => { if (!registry.main()) add({ kind: 'main' }); },
    resolveGroup: async (id) => group.sessionIds.includes(id) ? group : { hostId: 'local', groupId: id, sessionIds: [id] },
    saveSnapshot: async (sender, state) => { if (failSave) throw new Error('attachment unavailable'); saves.push(String(sender.id)); for (const draft of state.drafts) drafts.set(draft.sessionId, draft.text); },
    saveForClose: async (sender, state) => {
      saves.push(String(sender.id));
      for (const draft of state.drafts) drafts.set(draft.sessionId, draft.text);
      return { snapshot: state, losses: failSave ? ['attachment unavailable'] : [] };
    },
    confirmClose: async (_sender, losses) => {
      (closeWarnings as string[][]).push([...losses]);
      if (closeGate) { const gate = closeGate; closeGate = undefined; gate.started(); await gate.wait; }
      if (failConfirmation) throw new Error('confirmation failed');
      return closeAnyway;
    },
    adoptSnapshot: async (_sender, snapshot) => {
      if (failAdopt) throw new Error('copy no longer available');
      for (const draft of snapshot.drafts) drafts.delete(draft.sessionId);
    },
    loadSnapshot: async (sender, ids) => { if (failLoad) throw new Error('recovery capacity'); loads.push(String(sender.id)); return toSnapshot([...drafts].filter(([id]) => ids.includes(id))); },
    forgetSnapshot: (_sender, snapshot) => { for (const draft of snapshot.drafts) drafts.delete(draft.sessionId); },
    releaseSnapshot: (sender) => { released.push(String(sender.id)); },
    transferResources: async ({ source, target }) => { migrations.push(`${source?.id}->${target.id}`); },
    releaseResources: () => { if (failRelease) throw new Error('resource release failed'); },
    isQuitting: () => false,
    onError: (error) => { errors.push(error); },
    commandTimeoutMs: 30,
  });
  coordinator.sessionWindowReady(main.webContents as never);
  return {
    coordinator, registry, main, windows, commands, errors, migrations, saves, loads, released,
    pauseNextMainRestore() {
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      restoreGate = { started, wait };
      return { entered, release };
    },
    drafts, closeWarnings, mainCommands,
    pauseCloseConfirmation() {
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      closeGate = { started, wait: new Promise<void>((resolve) => { release = resolve; }) };
      return { entered, release };
    },
    closeAnyway: () => { closeAnyway = true; },
    failRestore: () => { failRestore = 'session'; },
    failMainRestore: () => { failRestore = 'main'; },
    delayPrepare: (wait: Promise<void>) => { prepareWait = wait; },
    failSave: () => { failSave = true; },
    failAdopt: () => { failAdopt = true; },
    failConfirmation: () => { failConfirmation = true; },
    failLoad: () => { failLoad = true; },
    failRelease: () => { failRelease = true; },
  };
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 10)); };

test('duplicate opens and group members share one independent window', async () => {
  const h = harness();
  await Promise.all([
    h.coordinator.openSessionWindow(h.main.webContents as never, 'A'),
    h.coordinator.openSessionWindow(h.main.webContents as never, 'A-child'),
  ]);
  assert.equal(h.windows.length, 2);
  const child = h.windows[1]!;
  assert.equal(child.revealed, true);
  assert.equal(h.coordinator.ownerForSession('A-version'), child.webContents);
  assert.equal(h.coordinator.canUseSession(h.main.webContents as never, 'A'), false);
  assert.equal(await h.coordinator.routeSession(h.main.webContents as never, { sessionId: 'A-version' }), 'routed');
  assert.equal(await h.coordinator.routeSession(child.webContents as never, { sessionId: 'A-child' }), 'local');
  assert.equal(h.commands.filter(({ command }) => command.kind === 'clear').length, 1);
  assert.deepEqual(h.loads, ['2'], 'only the receiving renderer gets attachment recovery handles');
});

test('unrelated child navigation targets the main window without replacing the child', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  assert.equal(await h.coordinator.routeSession(child.webContents as never, { sessionId: 'B' }), 'routed');
  assert.equal(h.commands.at(-1)?.windowId, h.main.id);
  assert.equal(h.coordinator.ownerForSession('A'), child.webContents);
  assert.equal(child.destroyed, false);
});

test('returning transfers current child member and closes only after restore', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  child.active = 'A-child';
  await h.coordinator.openInMainWindow(child.webContents as never);
  assert.equal(child.destroyed, true);
  assert.equal(h.errors.length, 0);
  assert.equal(h.coordinator.ownerForSession('A'), undefined);
  const restore = h.commands.at(-1)?.command;
  assert.equal(restore?.kind, 'restore');
  if (restore?.kind === 'restore') assert.equal(restore.navigation.sessionId, 'A-child');
  assert.deepEqual(h.migrations, ['1->2', '2->1']);
});

test('failed destination restoration revokes it before restoring original owner', async () => {
  const h = harness();
  h.failRestore();
  await assert.rejects(h.coordinator.openSessionWindow(h.main.webContents as never, 'A'), /restore failed/);
  assert.equal(h.windows[1]?.destroyed, true);
  assert.equal(h.coordinator.ownerForSession('A'), undefined);
  assert.equal(h.main.destroyed, false);
  assert.deepEqual(h.migrations, ['1->2', '2->1']);
  assert.deepEqual(h.loads, ['2', '1'], 'issue once to destination and once to rollback source');
  assert.deepEqual(h.released, ['2'], 'discard failed destination handles before rollback');
  const tail = h.commands.slice(-2);
  assert.deepEqual(tail.map(({ windowId, command }) => [windowId, command.kind]), [['2', 'clear'], ['1', 'restore']]);
});

test('normal close saves workspace before releasing ownership and does not close main', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.windows[1]!.close();
  assert.equal(h.windows[1]!.destroyed, false);
  await settle();
  assert.equal(h.windows[1]!.destroyed, true);
  assert.equal(h.errors.length, 0);
  assert.equal(h.main.destroyed, false);
  assert.equal(h.coordinator.ownerForSession('A'), undefined);
  assert.equal(await h.coordinator.routeSession(h.main.webContents as never, { sessionId: 'A' }), 'local');
});

test('canceling a close with attachment losses keeps the child and its ownership', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.failSave();
  h.windows[1]!.close();
  await settle();
  assert.equal(h.windows[1]!.destroyed, false);
  assert.equal(h.coordinator.ownerForSession('A'), h.windows[1]!.webContents);
  assert.deepEqual(h.closeWarnings, [['attachment unavailable']]);
});

test('closing main leaves the session window and return recreates main', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.main.close();
  await settle();
  assert.equal(h.main.destroyed, true);
  assert.equal(h.windows[1]!.destroyed, false);
  await h.coordinator.openInMainWindow(h.windows[1]!.webContents as never);
  assert.equal(h.windows.length, 3);
  assert.equal(h.registry.main()?.context.windowId, '3');
});


test('failed return restores child ownership and the main window previous task', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.main.active = 'B';
  h.failMainRestore();
  await assert.rejects(h.coordinator.openInMainWindow(h.windows[1]!.webContents as never), /restore failed/);
  assert.equal(h.coordinator.ownerForSession('A'), h.windows[1]!.webContents);
  assert.equal(h.windows[1]!.destroyed, false);
  assert.equal(h.main.active, 'B');
  assert.equal(h.commands.at(-1)?.command.kind, 'resume');
});

test('reloaded child restores the last viewed group member without opening another window', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  await h.coordinator.routeSession(child.webContents as never, { sessionId: 'A-child' });
  child.webContents.emit('render-process-gone');
  h.coordinator.sessionWindowReady(child.webContents as never);
  await settle();
  assert.equal(h.windows.length, 2);
  const last = h.commands.at(-1)?.command;
  assert.equal(last?.kind, 'navigate');
  if (last?.kind === 'navigate') assert.equal(last.navigation.sessionId, 'A-child');
  assert.equal(h.loads.length, 1, 'reload never replays an adopted draft');
});

test('synchronous cleanup failure after native destruction is reported without throwing from closed', async () => {
  const h = harness();
  h.failRelease();
  assert.doesNotThrow(() => h.main.destroy());
  assert.throws(() => h.main.webContents, /Object has been destroyed/);
  await settle();
  assert.equal(h.errors.length, 1);
  assert.match(String(h.errors[0]), /resource release failed/);
});


test('navigation IPC accepts omitted optional fields from a normal session row', async () => {
  const h = harness();
  const handlers = new Map<string, (event: any, input: unknown) => any>();
  registerSessionWindowIpc(h.coordinator, { handle: (channel: string, listener: (event: any, input: unknown) => any) => { handlers.set(channel, listener); } } as never);
  const route = handlers.get('session-window:route')!;
  const event = { sender: h.main.webContents, senderFrame: undefined };
  assert.equal(await route(event, { sessionId: 'A', turnId: undefined, sequence: undefined }), 'local');
  assert.equal(await route(event, { sessionId: 'A', turnId: 'turn-1', sequence: 0 }), 'local');
  assert.throws(() => route(event, { sessionId: 'A', turnId: 1 }), /Invalid turn identity/);
  assert.throws(() => route(event, { sessionId: 'A', sequence: -1 }), /Invalid turn sequence/);
});


test('concurrent groups returning to a recreated main preserve both drafts and serialize restoration', async () => {
  const h = harness();
  h.main.drafts.set('A', 'draft A');
  h.main.drafts.set('B', 'draft B');
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.main.active = 'B';
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'B');
  const a = h.windows[1]!;
  const b = h.windows[2]!;
  b.active = 'B';
  h.main.close();
  await settle();
  const gate = h.pauseNextMainRestore();
  const returning = Promise.all([
    h.coordinator.openInMainWindow(a.webContents as never),
    h.coordinator.openInMainWindow(b.webContents as never),
  ]);
  await gate.entered;
  assert.equal(h.windows.length, 4, 'one replacement main window is shared by both returns');
  const main = h.windows[3]!;
  assert.equal(h.commands.filter(({ windowId, command }) => windowId === main.id && command.kind === 'prepare-navigation').length, 1,
    'B must wait until A has restored before switching the shared main workspace');
  gate.release();
  await returning;
  assert.equal(a.destroyed, true);
  assert.equal(b.destroyed, true);
  assert.equal(main.drafts.get('A'), 'draft A');
  assert.equal(main.drafts.get('B'), 'draft B');
  assert.equal(h.drafts.size, 0, 'live renderer owns adopted drafts; no stale main-process copies');
  assert.equal(h.errors.length, 0);
});


test('adopted snapshots are removed while closed-window snapshots wait for their next owner', async () => {
  const h = harness();
  h.main.drafts.set('A', 'unsent');
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  assert.equal(h.drafts.size, 0);
  child.drafts.set('A', 'newer unsent');
  child.close();
  await settle();
  assert.equal(h.drafts.get('A'), 'newer unsent');
  const snapshot = await h.coordinator.loadSnapshot(h.main.webContents as never, ['A']);
  await h.coordinator.adoptSnapshot(h.main.webContents as never, snapshot);
  assert.equal(h.drafts.size, 0);
});


test('failed handoff before source clear and failed normal close discard stale custody', async () => {
  for (const operation of ['load', 'close'] as const) {
    const h = harness();
    h.main.drafts.set('A', 'old unsent draft');
    if (operation === 'load') {
      h.failLoad();
      await assert.rejects(h.coordinator.openSessionWindow(h.main.webContents as never, 'A'), /recovery capacity/);
    } else {
      h.failSave();
      h.main.close();
      await settle();
    }
    assert.equal(h.main.destroyed, false);
    assert.equal(h.main.drafts.get('A'), 'old unsent draft');
    h.main.drafts.set('A', ''); // The owner can continue editing or send successfully.
    assert.equal(h.drafts.size, 0, 'a resumed owner must not leave a stale draft to replay');
  }
});


test('a timed-out source preparation resumes its window and ignores the late snapshot', async () => {
  const h = harness();
  h.main.drafts.set('A', 'draft');
  let complete!: () => void;
  h.delayPrepare(new Promise<void>((resolve) => { complete = resolve; }));
  await assert.rejects(h.coordinator.openSessionWindow(h.main.webContents as never, 'A'), /not confirmed/);
  assert.ok(h.commands.some(({ windowId, command }) => windowId === h.main.id && command.kind === 'resume'));
  complete();
  await settle();
  assert.equal(h.main.destroyed, false);
  assert.equal(h.drafts.size, 0);
});

test('late replies cannot discard a snapshot belonging to another window', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  const retained = { ...snapshot(), drafts: [{ sessionId: 'A', text: 'child draft', references: [], attachments: [], directoryReferences: [], quotes: [] }] };
  await h.coordinator.saveSnapshot(child.webContents as never, retained);
  h.coordinator.reply(h.main.webContents as never, { requestId: 'invented', ok: true, result: { snapshot: retained } });
  await settle();
  assert.equal(h.drafts.get('A'), 'child draft');
  assert.equal(h.errors.length, 0, 'late replies have no side effects');
});


test('confirmed attachment loss closes once and still runs native close finalization', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  const child = h.windows[1]!;
  let nativeFinalizations = 0;
  child.on('close', (event) => { if (!event.defaultPrevented) nativeFinalizations += 1; });
  h.failSave();
  h.closeAnyway();
  child.close();
  await settle();
  assert.equal(child.destroyed, true);
  assert.equal(nativeFinalizations, 1);
  assert.equal(h.closeWarnings.length, 1);
  assert.equal(h.commands.filter(({ windowId, command }) => windowId === child.id && command.kind === 'flush').length, 1);
});

test('closing B does not wait for A restoring into Main', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'B');
  const a = h.windows[1]!;
  const b = h.windows[2]!;
  const gate = h.pauseNextMainRestore();
  const returning = h.coordinator.openInMainWindow(a.webContents as never);
  await gate.entered;
  b.close();
  await settle();
  assert.equal(b.destroyed, true);
  assert.equal(a.destroyed, false);
  gate.release();
  await returning;
});

test('returning A never exports unrelated B drafts in Main', async () => {
  const h = harness();
  h.main.drafts.set('A', 'A draft');
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.main.active = 'B';
  h.main.drafts.set('B', 'B draft with an unavailable attachment');
  const previousSaves = h.saves.length;
  await h.coordinator.openInMainWindow(h.windows[1]!.webContents as never);
  assert.deepEqual(h.saves.slice(previousSaves), ['2']);
  assert.equal(h.main.drafts.get('B'), 'B draft with an unavailable attachment');
  assert.equal(h.main.active, 'A');
});


test('main commands cannot enter Main while its close confirmation is pending', async () => {
  const h = harness();
  await h.coordinator.openSessionWindow(h.main.webContents as never, 'A');
  h.failSave();
  h.closeAnyway();
  const gate = h.pauseCloseConfirmation();
  h.main.close();
  await gate.entered;
  const child = h.windows[1]!;
  for (const command of ['newTask', 'openSettings', 'openHelp'] as const) {
    await assert.rejects(h.coordinator.commandMain(child.webContents as never, command), /closing/);
  }
  assert.deepEqual(h.mainCommands, []);
  gate.release();
  await settle();
  assert.equal(h.main.destroyed, true);
  assert.equal(child.destroyed, false);
});

test('failed cancellation retains the recovery snapshot when custody cannot return to its renderer', async () => {
  const h = harness();
  h.main.drafts.set('A', 'recoverable unsent text');
  h.failSave();
  const gate = h.pauseCloseConfirmation();
  h.main.close();
  await gate.entered;
  h.failAdopt(); // A companion becomes unavailable while confirmation is open.
  gate.release();
  await settle();
  assert.equal(h.main.destroyed, false);
  assert.equal(h.drafts.get('A'), 'recoverable unsent text');
  assert.equal(h.commands.at(-1)?.command.kind, 'resume');
  assert.match(String(h.errors.at(-1)), /copy no longer available/);
});

test('a rejected close dialog returns custody and resumes the source', async () => {
  const h = harness();
  h.main.drafts.set('A', 'unsent text');
  h.failSave();
  h.failConfirmation();
  h.main.close();
  await settle();
  assert.equal(h.main.destroyed, false);
  assert.equal(h.drafts.size, 0, 'successful return to renderer releases the retained snapshot');
  assert.equal(h.main.drafts.get('A'), 'unsent text');
  assert.equal(h.commands.at(-1)?.command.kind, 'resume');
  assert.match(String(h.errors.at(-1)), /confirmation failed/);
});
