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

import { randomUUID } from 'node:crypto';
import type { IpcMain, WebContents } from 'electron';
import type {
  SessionWindowCommand, SessionWindowCommandReply, SessionWindowCommandResult,
  SessionWindowGroup, SessionWindowNavigation,
} from '../shared/session-window-contract.js';
import type { SessionWorkspaceSnapshot } from '../shared/session-workspace-state.js';
import type { MainWindowController } from './main-window.js';
import type { WorkspaceWindowEntry } from './workspace-window-registry.js';

type CommandInput = SessionWindowCommand extends infer Command
  ? Command extends SessionWindowCommand ? Omit<Command, 'requestId'> : never : never;

export interface SessionWindowCoordinatorDeps {
  readonly windows: MainWindowController;
  readonly signal: AbortSignal;
  readonly ensureMainWindow: () => Promise<void>;
  readonly resolveGroup: (sessionId: string) => Promise<SessionWindowGroup>;
  readonly saveSnapshot: (sender: WebContents, snapshot: SessionWorkspaceSnapshot) => Promise<void>;
  readonly saveForClose: (sender: WebContents, snapshot: SessionWorkspaceSnapshot) => Promise<{ snapshot: SessionWorkspaceSnapshot; losses: readonly string[] }>;
  readonly confirmClose: (sender: WebContents, losses: readonly string[]) => Promise<boolean>;
  readonly adoptSnapshot: (sender: WebContents, snapshot: SessionWorkspaceSnapshot) => Promise<void>;
  readonly forgetSnapshot: (sender: WebContents, snapshot: SessionWorkspaceSnapshot) => void;
  readonly loadSnapshot: (sender: WebContents, sessionIds: readonly string[]) => Promise<SessionWorkspaceSnapshot>;
  readonly releaseSnapshot: (sender: WebContents, snapshot: SessionWorkspaceSnapshot) => void;
  readonly transferResources: (input: {
    readonly group: SessionWindowGroup;
    readonly source: WebContents | undefined;
    readonly target: WebContents;
  }) => Promise<void>;
  readonly releaseResources: (sender: WebContents) => void | Promise<void>;
  readonly isQuitting: () => boolean;
  readonly onError: (error: unknown, sender?: WebContents) => void;
  readonly commandTimeoutMs?: number;
}

/** A process-scoped ownership authority; a renderer never chooses its own owner. */
export function createSessionWindowCoordinator(deps: SessionWindowCoordinatorDeps) {
  const registry = deps.windows.registry;
  const owners = new Map<string, string>();
  const groups = new Map<string, SessionWindowGroup>();
  const memberGroups = new Map<string, string>();
  const queues = new Map<string, Promise<unknown>>();
  let mainPresentation: Promise<unknown> = Promise.resolve();
  const ready = new Set<string>();
  const selections = new Map<string, SessionWindowNavigation>();
  const readyWaiters = new Map<string, Set<(error?: Error) => void>>();
  const pending = new Map<string, {
    windowId: string;
    resolve: (result: SessionWindowCommandResult) => void;
    reject: (error: Error) => void;
  }>();
  const closing = new Set<string>();
  const finalized = new Set<string>();
  const timeoutMs = deps.commandTimeoutMs ?? 20_000;
  const groupKey = (group: SessionWindowGroup): string => JSON.stringify([group.hostId, group.groupId]);
  const reportError = (error: unknown, sender?: WebContents): void => deps.onError(error, sender);

  function requireWindow(sender: WebContents): WorkspaceWindowEntry {
    const entry = registry.forSender(sender);
    if (!entry) throw new Error('This operation requires a workspace window');
    return entry;
  }

  function rejectWindowRequests(windowId: string): void {
    ready.delete(windowId);
    for (const complete of readyWaiters.get(windowId) ?? []) complete(new Error('The workspace window closed'));
    readyWaiters.delete(windowId);
    for (const operation of pending.values()) {
      if (operation.windowId === windowId) operation.reject(new Error('The workspace window closed'));
    }
  }

  function attachWindow(entry: WorkspaceWindowEntry): void {
    const windowId = entry.context.windowId;
    const sender = entry.window.webContents;
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) rejectWindowRequests(windowId);
    });
    sender.on('render-process-gone', () => {
      rejectWindowRequests(windowId);
      void Promise.resolve().then(() => deps.releaseResources(sender)).catch((error) => reportError(error, sender));
    });
    entry.window.once('closed', () => {
      rejectWindowRequests(windowId);
      void Promise.resolve().then(() => deps.releaseResources(sender)).catch((error) => reportError(error, sender));
      for (const [key, owner] of owners) if (owner === windowId) owners.delete(key);
      selections.delete(windowId);
      finalized.delete(windowId);
    });
    entry.window.on('close', (event) => {
      if (deps.isQuitting() || finalized.has(windowId) || !ready.has(windowId)) return;
      event.preventDefault();
      if (closing.has(windowId)) return;
      closing.add(windowId);
      let retainedSnapshot: SessionWorkspaceSnapshot | undefined;
      void (async () => {
        // Only the owning group's queue can touch a child. Other children may
        // close while a transfer to Main is still waiting for its renderer.
        const key = entry.context.kind === 'session' && memberGroups.get(entry.context.initialSessionId);
        await Promise.allSettled(entry.context.kind === 'main' ? [mainPresentation] : key ? [queues.get(key)] : []);
        if (entry.window.isDestroyed()) return;
        const losses: string[] = [];
        try {
          const result = await request(entry, { kind: 'flush' });
          if (!result.snapshot) throw new Error('The window did not confirm its workspace');
          await requireSnapshotOwner(sender, result.snapshot);
          const retained = await deps.saveForClose(sender, result.snapshot);
          losses.push(...retained.losses);
          retainedSnapshot = retained.snapshot;
        } catch (error) {
          losses.push(error instanceof Error ? error.message : String(error));
        }
        const confirmed = !losses.length || await deps.confirmClose(sender, losses).catch((error) => {
          reportError(error, sender);
          return false;
        });
        if (!confirmed) {
          if (retainedSnapshot) await deps.adoptSnapshot(sender, retainedSnapshot);
          await request(entry, { kind: 'resume' });
          return;
        }
        // Detach only after custody has been saved (or the user accepted loss).
        // A stalled renderer must not prevent an explicitly confirmed close.
        await request(entry, { kind: 'detach' }).catch(() => undefined);
        finalized.add(windowId);
        entry.window.close();
      })().catch(async (error) => {
        // A failed cancellation rolls copy custody back to the workspace. Keep
        // its snapshot until a later successful adoption can release both.
        if (!entry.window.isDestroyed()) await request(entry, { kind: 'resume' }).catch(() => undefined);
        reportError(error, sender);
      }).finally(() => closing.delete(windowId));
    });
  }
  for (const entry of registry.entries()) attachWindow(entry);
  const unsubscribe = registry.onRegistered(attachWindow);

  async function resolveGroup(sessionId: string): Promise<SessionWindowGroup> {
    const resolved = await deps.resolveGroup(sessionId);
    // Keep a known group stable when its root is deleted or temporarily absent.
    const knownKeys = new Set(resolved.sessionIds.map((id) => memberGroups.get(id)).filter((id): id is string => !!id));
    const ownKnown = memberGroups.get(sessionId);
    const key = ownKnown ?? [...knownKeys].find((id) => owners.has(id)) ?? groupKey(resolved);
    const previous = groups.get(key);
    const group: SessionWindowGroup = {
      ...resolved,
      groupId: previous?.groupId ?? resolved.groupId,
      sessionIds: [...new Set([...(previous?.sessionIds ?? []), ...resolved.sessionIds])],
    };
    const conflicting = [...knownKeys].filter((id) => id !== key && owners.has(id));
    if (conflicting.length) throw new Error('Related sessions are already assigned to different windows');
    groups.set(key, group);
    for (const member of group.sessionIds) memberGroups.set(member, key);
    return group;
  }

  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
    return next;
  }

  // Every transfer touches the one main workspace. Keep its snapshot/restore
  // transaction intact across unrelated groups; always acquire group first.
  function withMainPresentation<T>(operation: () => Promise<T>): Promise<T> {
    const next = mainPresentation.catch(() => undefined).then(operation);
    mainPresentation = next;
    return next;
  }

  async function waitReady(entry: WorkspaceWindowEntry): Promise<void> {
    const id = entry.context.windowId;
    if (ready.has(id)) return;
    await new Promise<void>((resolve, reject) => {
      const complete = (error?: Error): void => { clearTimeout(timer); waiters.delete(complete); if (error) reject(error); else resolve(); };
      const waiters = readyWaiters.get(id) ?? new Set<(error?: Error) => void>();
      readyWaiters.set(id, waiters);
      waiters.add(complete);
      const timer = setTimeout(() => {
        waiters.delete(complete);
        reject(new Error('The workspace window did not become ready'));
      }, timeoutMs);
    });
  }

  async function request(entry: WorkspaceWindowEntry, input: CommandInput): Promise<SessionWindowCommandResult> {
    await waitReady(entry);
    if (entry.window.isDestroyed()) throw new Error('The workspace window is unavailable');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => complete(new Error(`Workspace ${input.kind} was not confirmed`)), timeoutMs);
      const complete = (error?: Error, result?: SessionWindowCommandResult): void => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (error) reject(error);
        else resolve(result ?? {});
      };
      pending.set(requestId, {
        windowId: entry.context.windowId,
        resolve: (result) => complete(undefined, result),
        reject: (error) => complete(error),
      });
      try { entry.window.webContents.send('session-window:command', { ...input, requestId }); }
      catch (error) { complete(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  function owner(group: SessionWindowGroup): WorkspaceWindowEntry | undefined {
    const id = owners.get(groupKey(group));
    return id ? registry.get(id) : undefined;
  }

  async function ensureMain(): Promise<WorkspaceWindowEntry> {
    await deps.ensureMainWindow();
    const entry = registry.main();
    if (!entry) throw new Error('The main window is unavailable');
    await waitReady(entry);
    return entry;
  }

  async function navigate(entry: WorkspaceWindowEntry, group: SessionWindowGroup, navigation: SessionWindowNavigation): Promise<void> {
    assertOpen(entry);
    const apply = () => { assertOpen(entry); return navigateNow(entry, group, navigation); };
    return entry.context.kind === 'main' ? withMainPresentation(apply) : apply();
  }

  async function navigateNow(entry: WorkspaceWindowEntry, group: SessionWindowGroup, navigation: SessionWindowNavigation): Promise<void> {
    await request(entry, { kind: 'navigate', group, navigation });
    selections.set(entry.context.windowId, navigation);
    entry.controller.reveal();
    entry.controller.focus();
  }

  async function requireSnapshotOwner(sender: WebContents, snapshot: SessionWorkspaceSnapshot): Promise<void> {
    requireWindow(sender);
    const sessionIds = new Set([
      ...snapshot.drafts.map((draft) => draft.sessionId),
      ...snapshot.sideConversations.map((side) => side.panel.sourceSessionId),
      ...Object.keys(snapshot.workbar ?? {}), ...Object.keys(snapshot.readingAnchors ?? {}),
    ]);
    for (const id of sessionIds) {
      if (!memberGroups.has(id)) await resolveGroup(id);
      if (!canUseSession(sender, id)) throw new Error('This workspace belongs to another window');
    }
  }

  async function saveSnapshot(sender: WebContents, snapshot: SessionWorkspaceSnapshot): Promise<void> {
    await requireSnapshotOwner(sender, snapshot);
    await deps.saveSnapshot(sender, snapshot);
  }

  async function adoptSnapshot(sender: WebContents, snapshot: SessionWorkspaceSnapshot): Promise<void> {
    await requireSnapshotOwner(sender, snapshot);
    await deps.adoptSnapshot(sender, snapshot);
  }

  function assertOpen(entry: WorkspaceWindowEntry): void {
    if (entry.window.isDestroyed() || closing.has(entry.context.windowId)) throw new Error('The workspace window is closing');
  }

  function transfer(group: SessionWindowGroup, navigation: SessionWindowNavigation, target: WorkspaceWindowEntry, source?: WorkspaceWindowEntry): Promise<void> {
    assertOpen(target);
    if (source) assertOpen(source);
    return withMainPresentation(() => {
      assertOpen(target);
      if (source) assertOpen(source);
      return transferNow(group, navigation, target, source);
    });
  }

  async function transferNow(group: SessionWindowGroup, navigation: SessionWindowNavigation, target: WorkspaceWindowEntry, source?: WorkspaceWindowEntry): Promise<void> {
    const key = groupKey(group);
    const targetSender = target.window.webContents;
    const sourceSender = source?.window.webContents;
    const previousOwner = owners.get(key);
    let sourcePrepared = false;
    let sourceSnapshot: SessionWorkspaceSnapshot | undefined;
    let sourceCleared = false;
    let resourcesMoved = false;
    let committed = false;
    let activeSessionId: string | undefined;
    let targetRetained: SessionWindowCommandResult | undefined;
    let targetPrepared = false;
    let snapshot: SessionWorkspaceSnapshot | undefined;
    try {
      await waitReady(target);
      if (target.context.kind === 'main') {
        targetPrepared = true;
        targetRetained = await request(target, { kind: 'prepare-navigation' });
      }
      if (source) {
        sourcePrepared = true;
        const prepared = await request(source, { kind: 'prepare-transfer', group });
        if (!prepared.snapshot) throw new Error('The source window did not save its workspace');
        activeSessionId = prepared.activeSessionId;
        await saveSnapshot(sourceSender!, prepared.snapshot);
        sourceSnapshot = prepared.snapshot;
      }
      // Issue handles only to the renderer that will receive them. A read is an
      // allocation, so obtain it once and before clearing the source workspace.
      snapshot = await deps.loadSnapshot(targetSender, group.sessionIds);
      if (source) {
        sourceCleared = true;
        await request(source, { kind: 'clear', group });
      }
      if (target.context.kind === 'session') owners.set(key, target.context.windowId);
      else owners.delete(key);
      committed = true;
      resourcesMoved = true;
      await deps.transferResources({ group, source: sourceSender, target: targetSender });
      await request(target, { kind: 'restore', group, navigation, snapshot });
      await deps.adoptSnapshot(targetSender, snapshot);
      selections.set(target.context.windowId, navigation);
      target.controller.reveal();
      target.controller.focus();
      if (source?.context.kind === 'session') source.window.destroy();
    } catch (error) {
      // Revoke the destination before reactivating the source. If it cannot
      // acknowledge revocation, destroy it; never leave two operable owners.
      if (committed && !target.window.isDestroyed()) {
        try { await request(target, { kind: 'clear', group }); }
        catch { target.window.destroy(); }
      }
      if (snapshot) deps.releaseSnapshot(targetSender, snapshot);
      if (previousOwner) owners.set(key, previousOwner); else owners.delete(key);
      if (source && !source.window.isDestroyed()) {
        if (resourcesMoved) {
          await deps.transferResources({ group, source: targetSender, target: sourceSender! });
        }
        if (sourceCleared && activeSessionId && group.sessionIds.includes(activeSessionId)) {
          const restored = await deps.loadSnapshot(sourceSender!, group.sessionIds);
          try {
            await request(source, { kind: 'restore', group, navigation: { sessionId: activeSessionId }, snapshot: restored });
            await deps.adoptSnapshot(sourceSender!, restored);
          }
          catch (restoreError) { deps.releaseSnapshot(sourceSender!, restored); throw restoreError; }
        } else if (sourcePrepared) {
          if (!sourceCleared && sourceSnapshot) await deps.adoptSnapshot(sourceSender!, sourceSnapshot);
          await request(source, { kind: 'resume', group });
        }
      }
      if (target.context.kind === 'main' && !target.window.isDestroyed() && targetPrepared) {
        await request(target, { kind: 'resume',
          ...(committed ? { navigation: targetRetained?.activeSessionId ? { sessionId: targetRetained.activeSessionId } : null } : {}),
        });
      }
      throw error;
    }
  }

  async function routeSession(sender: WebContents, navigation: SessionWindowNavigation): Promise<'local' | 'routed'> {
    const origin = requireWindow(sender);
    assertOpen(origin);
    const group = await resolveGroup(navigation.sessionId);
    return serial(groupKey(group), async () => {
      assertOpen(origin);
      const destination = owner(group);
      if (destination) {
        if (destination === origin) { selections.set(origin.context.windowId, navigation); return 'local'; }
        await navigate(destination, group, navigation);
        return 'routed';
      }
      if (origin.context.kind === 'main') return withMainPresentation(async () => {
        assertOpen(origin);
        selections.set(origin.context.windowId, navigation);
        return 'local' as const;
      });
      await navigate(await ensureMain(), group, navigation);
      return 'routed';
    });
  }

  async function openSessionWindow(sender: WebContents, sessionId: string): Promise<void> {
    requireWindow(sender);
    const group = await resolveGroup(sessionId);
    await serial(groupKey(group), async () => {
      const existing = owner(group);
      if (existing) { await navigate(existing, group, { sessionId }); return; }
      const source = registry.main();
      const controller = await deps.windows.createSessionWindow({ kind: 'session', group, initialSessionId: sessionId }, deps.signal);
      const window = controller.browserWindow();
      if (!window) throw new Error('The session window could not be created');
      const target = requireWindow(window.webContents);
      try { await transfer(group, { sessionId }, target, source); }
      catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    });
  }

  async function openInMainWindow(sender: WebContents): Promise<void> {
    const origin = requireWindow(sender);
    assertOpen(origin);
    if (origin.context.kind !== 'session') return;
    const initial = origin.context.initialSessionId;
    const group = await resolveGroup(initial);
    await serial(groupKey(group), async () => {
      if (owner(group) !== origin) throw new Error('The session window no longer owns this workspace');
      // prepare-transfer returns the current member; use it when available in
      // transfer rather than switching the user back to the original root.
      try {
        const current = await request(origin, { kind: 'prepare-transfer', group });
        const sessionId = current.activeSessionId && group.sessionIds.includes(current.activeSessionId) ? current.activeSessionId : initial;
        await transfer(group, { sessionId }, await ensureMain(), origin);
      }
      catch (error) {
        if (!origin.window.isDestroyed()) await request(origin, { kind: 'resume', group }).catch(() => undefined);
        throw error;
      }
    });
  }

  function ownerForSession(sessionId: string): WebContents | undefined {
    const key = memberGroups.get(sessionId);
    const windowId = key && owners.get(key);
    return windowId ? registry.get(windowId)?.window.webContents : undefined;
  }

  function canUseSession(sender: WebContents, sessionId: string): boolean {
    const entry = registry.forSender(sender);
    if (!entry) return false;
    const owned = ownerForSession(sessionId);
    if (owned) return owned === sender;
    return entry.context.kind === 'main';
  }

  return {
    context: (sender: WebContents) => requireWindow(sender).context,
    routeSession, openSessionWindow, openInMainWindow, ownerForSession, canUseSession, saveSnapshot, adoptSnapshot,
    refreshGroup: resolveGroup,
    async loadSnapshot(sender: WebContents, sessionIds: readonly string[]) {
      requireWindow(sender);
      for (const id of sessionIds) {
        if (!memberGroups.has(id)) await resolveGroup(id);
        if (!canUseSession(sender, id)) throw new Error('This workspace belongs to another window');
      }
      requireWindow(sender);
      return deps.loadSnapshot(sender, sessionIds);
    },
    sessionWindowReady(sender: WebContents): void {
      const entry = requireWindow(sender);
      if (ready.has(entry.context.windowId)) return;
      ready.add(entry.context.windowId);
      for (const callback of readyWaiters.get(entry.context.windowId) ?? []) callback();
      readyWaiters.delete(entry.context.windowId);
      if (entry.context.kind === 'session') {
        const key = memberGroups.get(entry.context.initialSessionId);
        const group = key ? groups.get(key) : undefined;
        if (key && group && owners.get(key) === entry.context.windowId) {
          const navigation = selections.get(entry.context.windowId) ?? { sessionId: entry.context.initialSessionId };
          void serial(key, async () => {
            if (owner(group) !== entry) return;
            await request(entry, { kind: 'navigate', group, navigation });
            entry.controller.reveal();
          }).catch((error) => reportError(error, sender));
        }
      }
    },
    reply(sender: WebContents, reply: SessionWindowCommandReply): void {
      const entry = requireWindow(sender);
      const operation = pending.get(reply.requestId);
      if (!operation) return; // Capture alone never transfers custody; ignore late replies.
      if (operation.windowId !== entry.context.windowId) return;
      if (reply.ok) operation.resolve(reply.result ?? {});
      else operation.reject(new Error(reply.error));
    },
    async focusSession(sessionId: string): Promise<void> {
      const group = await resolveGroup(sessionId);
      await serial(groupKey(group), async () => navigate(owner(group) ?? await ensureMain(), group, { sessionId }));
    },
    async commandMain(sender: WebContents, command: 'newTask' | 'openSettings' | 'openHelp'): Promise<void> {
      const origin = requireWindow(sender);
      assertOpen(origin);
      const entry = await ensureMain();
      await withMainPresentation(async () => {
        assertOpen(origin);
        assertOpen(entry);
        entry.window.webContents.send('window:command', { id: command });
        entry.controller.focus();
      });
    },
    dispose(): void {
      unsubscribe();
      for (const callbacks of readyWaiters.values()) for (const complete of callbacks) complete(new Error('Window coordination stopped'));
      readyWaiters.clear();
      for (const operation of pending.values()) operation.reject(new Error('Window coordination stopped'));
    },
  };
}

export type SessionWindowCoordinator = ReturnType<typeof createSessionWindowCoordinator>;

export function registerSessionWindowIpc(coordinator: SessionWindowCoordinator, ipc: Pick<IpcMain, 'handle'>): void {
  function handle(channel: string, action: (sender: WebContents, input: any) => unknown): void {
    ipc.handle(`session-window:${channel}`, (event, input: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Session windows require the main frame');
      coordinator.context(event.sender);
      return action(event.sender, input);
    });
  }
  handle('context', (sender) => coordinator.context(sender));
  handle('ready', (sender) => coordinator.sessionWindowReady(sender));
  handle('route', (sender, input: unknown) => coordinator.routeSession(sender, requireNavigation(input)));
  handle('open', (sender, input: unknown) => coordinator.openSessionWindow(sender, requireSessionId(input)));
  handle('open-main', (sender) => coordinator.openInMainWindow(sender));
  handle('reply', (sender, input: unknown) => {
    if (!input || typeof input !== 'object' || !('requestId' in input) || typeof input.requestId !== 'string' || !('ok' in input) || typeof input.ok !== 'boolean') throw new TypeError('Invalid window reply');
    if (!input.ok && (!('error' in input) || typeof input.error !== 'string')) throw new TypeError('Invalid window reply');
    return coordinator.reply(sender, input as SessionWindowCommandReply);
  });
  handle('adopt', (sender, input) => coordinator.adoptSnapshot(sender, input));
  handle('load', (sender, input: unknown) => {
    if (!Array.isArray(input)) throw new TypeError('Invalid session list');
    return coordinator.loadSnapshot(sender, input.map(requireSessionId));
  });
  handle('command-main', (sender, input: unknown) => {
    if (input !== 'newTask' && input !== 'openSettings' && input !== 'openHelp') throw new TypeError('Invalid main window command');
    return coordinator.commandMain(sender, input);
  });
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('Invalid session identity');
  return value;
}

function requireNavigation(input: unknown): SessionWindowNavigation {
  if (!input || typeof input !== 'object' || !('sessionId' in input)) throw new TypeError('Invalid session navigation');
  const sessionId = requireSessionId(input.sessionId);
  if ('turnId' in input && input.turnId !== undefined && (typeof input.turnId !== 'string' || input.turnId.length > 4096)) throw new TypeError('Invalid turn identity');
  if ('sequence' in input && input.sequence !== undefined && (typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence < 0)) throw new TypeError('Invalid turn sequence');
  return { sessionId, ...('turnId' in input && input.turnId !== undefined ? { turnId: input.turnId as string } : {}), ...('sequence' in input && input.sequence !== undefined ? { sequence: input.sequence as number } : {}) };
}
