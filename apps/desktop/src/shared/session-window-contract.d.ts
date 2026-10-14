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

import type { SessionWorkspaceSnapshot } from './session-workspace-state.js';

/** All session IDs in this contract are desktopSessionKey values, including members. */
export interface SessionWindowGroup {
  readonly hostId: string;
  readonly groupId: string;
  readonly sessionIds: readonly string[];
}

export interface SessionWindowNavigation {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sequence?: number;
}

export type SessionWindowContext =
  | { readonly kind: 'main'; readonly windowId: string }
  | {
      readonly kind: 'session';
      readonly windowId: string;
      readonly group: SessionWindowGroup;
      readonly initialSessionId: string;
    };

export type SessionWindowCommand =
  | { readonly requestId: string; readonly kind: 'prepare-transfer'; readonly group: SessionWindowGroup }
  | { readonly requestId: string; readonly kind: 'clear'; readonly group: SessionWindowGroup }
  | {
      readonly requestId: string;
      readonly kind: 'restore';
      readonly group: SessionWindowGroup;
      readonly navigation: SessionWindowNavigation;
      readonly snapshot: SessionWorkspaceSnapshot;
    }
  | { readonly requestId: string; readonly kind: 'navigate'; readonly navigation: SessionWindowNavigation; readonly group: SessionWindowGroup }
  | { readonly requestId: string; readonly kind: 'resume'; readonly group?: SessionWindowGroup }
  | { readonly requestId: string; readonly kind: 'flush' };

export interface SessionWindowCommandResult {
  readonly snapshot?: SessionWorkspaceSnapshot;
  readonly activeSessionId?: string;
}

export type SessionWindowCommandReply =
  | { readonly requestId: string; readonly ok: true; readonly result?: SessionWindowCommandResult }
  | { readonly requestId: string; readonly ok: false; readonly error: string };

export interface SessionWindowBridge {
  context(): Promise<SessionWindowContext>;
  routeSession(navigation: SessionWindowNavigation): Promise<'local' | 'routed'>;
  openSessionWindow(sessionId: string): Promise<void>;
  openInMainWindow(): Promise<void>;
  /** Called once the command handler is installed; distinct from first-paint readiness. */
  sessionWindowReady(): Promise<void>;
  subscribeSessionWindowCommand(handler: (command: SessionWindowCommand) => void): () => void;
  ackSessionWindowCommand(reply: SessionWindowCommandReply): Promise<void>;
  saveWorkspaceSnapshot(snapshot: SessionWorkspaceSnapshot): Promise<void>;
  /** Release main-process custody after the renderer adopts a handoff snapshot. */
  adoptWorkspaceSnapshot(snapshot: SessionWorkspaceSnapshot): Promise<void>;
  loadWorkspaceSnapshot(sessionIds: readonly string[]): Promise<SessionWorkspaceSnapshot>;
  /** Forward application-wide navigation without replacing a session window's task. */
  commandMain(command: 'newTask' | 'openSettings' | 'openHelp'): Promise<void>;
}
