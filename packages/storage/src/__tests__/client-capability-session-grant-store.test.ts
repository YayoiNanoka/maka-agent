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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createConversationOperationalStateStore } from '../conversation-operational-state.js';
import {
  closeSqliteInteractionStoreFacade,
  openSqliteInteractiveInteractionStoreForWrite,
} from '../interaction-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

after(removeTrackedControlDirectories);

test('persists Client Capability grants for one Session and purges them with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-client-capability-grant-'));
  try {
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const store = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
    const key = {
      sessionId: 'session-1',
      providerId: 'provider-1',
      contractId: 'contract-1',
      serverId: 'desktop_browser',
      toolName: 'browser_snapshot',
      capability: 'browser' as const,
      scope: { kind: 'browser_origin' as const, origin: 'https://example.com' },
    };
    try {
      const committed = await store.commitClientCapabilitySessionGrant({
        version: 1,
        ...key,
        grantedAt: 10,
      });
      assert.equal(committed.grantedAt, 10);
      assert.deepEqual(await store.readClientCapabilitySessionGrant(key), committed);

      const operationalState = createConversationOperationalStateStore(root);
      try {
        await operationalState.purge('session-1');
      } finally {
        operationalState.close();
      }
      assert.equal(await store.readClientCapabilitySessionGrant(key), undefined);
    } finally {
      closeSqliteInteractionStoreFacade(store);
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
