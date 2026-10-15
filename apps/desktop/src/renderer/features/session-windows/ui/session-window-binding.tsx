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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { ComposerHandle } from '@maka/ui';
import type { SessionWorkbarLayoutSnapshot } from '../../../../shared/session-workbar-state.js';
import { captureSessionWorkspace, clearSessionWorkspace, restoreSessionWorkspace, detachSessionWorkspace, resumeSessionWorkspace, type WorkspaceStagingOwner, type WorkspaceSubmissionOwner } from '../../../application/contracts/session-workspace-handoff.js';
import type { SessionWorkspaceSnapshot } from '../../../../shared/session-workspace-state.js';
import { createSessionWindowCommandHandler } from '../controller/session-window-command.js';
import { restoreSessionWindowWorkspace } from '../controller/session-window-navigation.js';
import type { SessionWindowNavigation } from '../ports.js';
import { useSessionWindowServices } from '../services-context.js';
import type { SessionWindowProjection } from './session-window-root.js';

const afterCommit = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Main commands and explicit user navigation converge before changing selection. */
export function SessionWindowBinding(props: {
  window: SessionWindowProjection;
  staging: WorkspaceStagingOwner;
  submission: WorkspaceSubmissionOwner;
  workbar: {
    captureWorkspace(sessionIds: readonly string[]): Readonly<Record<string, SessionWorkbarLayoutSnapshot>>;
    restoreWorkspace(snapshots: Readonly<Record<string, SessionWorkbarLayoutSnapshot>>): void;
  };
  conversation: {
    composer: { readonly current: ComposerHandle | null };
    readActiveSessionId(): string | undefined;
    clearSelection(): void;
    clearOwnedSessionState(sessionId: string): void;
    captureReadingAnchors(sessionIds: readonly string[]): Readonly<Record<string, { readonly turnId: string }>>;
    restoreReadingAnchors(anchors: Readonly<Record<string, { readonly turnId: string }>>, sessionIds: readonly string[]): void;
  };
  activeSessionId?: string;
  openLocal(navigation: SessionWindowNavigation): void;
  clearLocal(): void;
  refreshSessions(): Promise<unknown>;
  refreshMessages(sessionId: string): Promise<boolean>;
}) {
  const services = useSessionWindowServices();
  const conversation = props.conversation;
  const current = useRef({ props, conversation });
  useLayoutEffect(() => { current.current = { props, conversation }; });
  const visited = useRef(new Set<string>());
  const released = useRef(new Set<string>());
  // A first send creates its draft locally, with no handoff snapshot to load.
  // A released member must never
  // re-enter the save set through a delayed publication from its old viewer.
  if (props.activeSessionId && !released.current.has(props.activeSessionId)) visited.current.add(props.activeSessionId);

  useEffect(() => {
    let disposed = false;
    let queue = Promise.resolve();
    let restoresInFlight = 0;
    const owners = () => ({ composer: current.current.conversation.composer.current, staging: current.current.props.staging, submission: current.current.props.submission });
    const capture = async (ids: readonly string[]) => {
      const sessionIds = ids.filter((id) => visited.current.has(id));
      const snapshot = await captureSessionWorkspace({ ...owners(), sessionIds });
      return { ...snapshot, workbar: current.current.props.workbar.captureWorkspace(sessionIds),
        readingAnchors: current.current.conversation.captureReadingAnchors(sessionIds) };
    };
    const restore = (snapshot: SessionWorkspaceSnapshot) => {
      restoreSessionWorkspace({ ...owners(), snapshot });
      current.current.props.workbar.restoreWorkspace(snapshot.workbar ?? {});
      current.current.conversation.restoreReadingAnchors(snapshot.readingAnchors ?? {}, snapshot.drafts.map((draft) => draft.sessionId));
      for (const draft of snapshot.drafts) { released.current.delete(draft.sessionId); visited.current.add(draft.sessionId); }
    };
    const openWorkspace = async (sessionId: string, isCurrent: () => boolean, activate: () => void) => {
      if (visited.current.has(sessionId)) { if (isCurrent()) activate(); return; }
      released.current.add(sessionId);
      restoresInFlight += 1;
      flushSync(() => current.current.props.window.setRestoring(true));
      try {
        await restoreSessionWindowWorkspace({
        load: () => services.loadWorkspaceSnapshot([sessionId]),
        release: services.releaseSnapshot,
        adopt: services.adoptWorkspaceSnapshot,
        activate: async (snapshot) => {
          flushSync(() => {
            if (snapshot.capturedAt > 0) current.current.conversation.clearSelection();
            activate();
          });
          await current.current.props.refreshMessages(sessionId);
          await afterCommit();
        },
        isCurrent: () => !disposed && isCurrent(),
        restore: (snapshot) => {
          flushSync(() => restore(snapshot));
          released.current.delete(sessionId);
          visited.current.add(sessionId);
        },
        });
      } finally {
        restoresInFlight -= 1;
        if (!disposed && !restoresInFlight) current.current.props.window.setRestoring(false);
      }
    };
    props.window.lifecycle.current = { openWorkspace };
    const freeze = (value: boolean) => {
      flushSync(() => current.current.props.window.setFrozen(value));
    };
    const navigate = async (navigation: SessionWindowNavigation, loadSnapshot = true) => {
      await current.current.props.refreshSessions();
      const activate = () => flushSync(() => current.current.props.openLocal(navigation));
      if (loadSnapshot) await openWorkspace(navigation.sessionId, () => !disposed, activate);
      else flushSync(() => { current.current.conversation.clearSelection(); activate(); });
      await current.current.props.refreshMessages(navigation.sessionId);
      await afterCommit();
    };
    const execute = createSessionWindowCommandHandler({
      freeze, capture, navigate,
      activeSessionId: () => current.current.conversation.readActiveSessionId(),
      sessionIds: () => [...visited.current],
      restore: (snapshot) => flushSync(() => restore(snapshot)),
      clear: (sessionIds, clearSelection) => {
        for (const id of sessionIds) released.current.add(id);
        flushSync(() => {
          clearSessionWorkspace({ ...owners(), sessionIds });
          for (const id of sessionIds) current.current.conversation.clearOwnedSessionState(id);
          current.current.conversation.restoreReadingAnchors({}, sessionIds);
          if (clearSelection) current.current.props.clearLocal();
        });
        for (const id of sessionIds) visited.current.delete(id);
      },
      detach: detachSessionWorkspace,
      resume: () => resumeSessionWorkspace(),
    });
    const unsubscribe = services.subscribeSessionWindowCommand((command) => {
      queue = queue.then(async () => {
        if (disposed) return;
        try {
          const result = await execute(command);
          await services.ackSessionWindowCommand({ requestId: command.requestId, ok: true, result });
        } catch (error) {
          await services.ackSessionWindowCommand({ requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
    const unsubscribeDeleted = services.subscribeDeleted((sessionId) => {
      released.current.add(sessionId);
      visited.current.delete(sessionId);
      // An authoritative deletion is final even while another command was
      // capturing. Exclude it immediately, then serialize local owner cleanup.
      queue = queue.then(() => {
        if (disposed) return;
        const clearSelection = current.current.conversation.readActiveSessionId() === sessionId;
        flushSync(() => {
          clearSessionWorkspace({ ...owners(), sessionIds: [sessionId] });
          current.current.conversation.clearOwnedSessionState(sessionId);
          current.current.conversation.restoreReadingAnchors({}, [sessionId]);
          if (clearSelection) current.current.props.clearLocal();
        });
      });
    });
    void services.sessionWindowReady();
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeDeleted();
      props.window.lifecycle.current = undefined;
    };
  }, [services, props.window.lifecycle]);
  return null;
}
