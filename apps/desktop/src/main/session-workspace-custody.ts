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

import type { SessionCopyCleanupAuthority } from '@maka/storage/session-copy-cleanup';
import type { SessionWorkspaceSnapshot, SideConversationWorkspaceState } from '../shared/session-workspace-state.js';

export interface WorkspaceCopyLease {
  authority: SessionCopyCleanupAuthority;
  sessionId: string;
  sourceSessionId: string;
}

/** Move the existing cleanup leases with their workspace, including partial failure. */
export async function adoptWorkspaceCopies(snapshot: SessionWorkspaceSnapshot, deps: {
  resolve(side: SideConversationWorkspaceState): WorkspaceCopyLease;
  ownerId: string;
  previousOwnerId: string;
  unavailable?(side: SideConversationWorkspaceState, error: unknown): void;
}): Promise<void> {
  const adopted: WorkspaceCopyLease[] = [];
  try {
    for (const side of snapshot.sideConversations) {
      if (!side.companion) continue;
      try {
        const lease = deps.resolve(side);
        await lease.authority.adopt(lease.sessionId, lease.sourceSessionId, deps.ownerId);
        adopted.push(lease);
      } catch (error) {
        if (!deps.unavailable) throw error;
        deps.unavailable(side, error);
      }
    }
  } catch (error) {
    // A failed transfer leaves every successfully moved copy with its prior
    // custodian. Never discard its snapshot while its lease is still parked.
    await Promise.all(adopted.map((lease) => lease.authority.adopt(lease.sessionId, lease.sourceSessionId, deps.previousOwnerId)));
    throw error;
  }
}
