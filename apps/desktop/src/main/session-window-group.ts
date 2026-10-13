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

import { linkedSubagentParentSessionId, sessionRevisionFamilyId, type SessionSummary } from '@maka/core/session';
import { isSideConversationSession } from '@maka/core/side-conversation';
import { desktopSessionKey, parseDesktopSessionKey } from '../shared/runtime-host-identity.js';
import type { SessionWindowGroup } from '../shared/session-window-contract.js';

export type WindowGroupSession = Pick<SessionSummary,
  'id' | 'revisionRootSessionId' | 'subagentParent' | 'subagent' | 'parentSessionId' | 'labels'>;

/** Retain ancestry for this app lifetime so deleting a parent cannot split its open family. */
export class SessionWindowGroups {
  readonly #catalogs = new Map<string, Map<string, WindowGroupSession>>();

  resolve(sessionKey: string, sessions: readonly WindowGroupSession[]): SessionWindowGroup {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    let catalog = this.#catalogs.get(hostId);
    if (!catalog) this.#catalogs.set(hostId, catalog = new Map());
    for (const session of sessions) catalog.set(session.id, session);
    if (!catalog.has(sessionId)) throw new Error('Session is unavailable');
    const familyOf = (id: string): string => {
      const session = catalog.get(id);
      return session ? sessionRevisionFamilyId(session) : id;
    };
    const parents = new Map<string, string>();
    for (const session of catalog.values()) {
      const parent = linkedSubagentParentSessionId(session)
        ?? (isSideConversationSession(session.labels) ? session.parentSessionId : undefined);
      const family = familyOf(session.id);
      if (parent && familyOf(parent) !== family) parents.set(family, familyOf(parent));
    }
    const rootOf = (id: string): string => {
      let current = familyOf(id);
      const seen: string[] = [];
      while (parents.has(current)) {
        const cycleStart = seen.indexOf(current);
        if (cycleStart >= 0) return seen.slice(cycleStart).sort()[0]!;
        seen.push(current);
        current = parents.get(current)!;
      }
      return current;
    };
    const root = rootOf(sessionId);
    const members = [...catalog.keys()].filter((id) => rootOf(id) === root);
    // Include a deleted/missing root identity in ownership checks as well.
    if (!members.includes(root)) members.push(root);
    return {
      hostId,
      groupId: desktopSessionKey({ hostId, sessionId: root }),
      sessionIds: members.sort().map((id) => desktopSessionKey({ hostId, sessionId: id })),
    };
  }

  forgetHost(hostId: string): void { this.#catalogs.delete(hostId); }
}
