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
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import {
  createFakeSessionNavigationServices,
  createSessionNavigationRowActions,
  type SessionNavigationSessionService,
} from '../../renderer/features/session-navigation/testing.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';

const copy = getShellCopy('en').sessionRowActions;

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    ...overrides,
  };
}

function harness(options: {
  setUnread?: SessionNavigationSessionService['setUnread'];
  pending?: Set<string>;
  refreshSessions?: () => Promise<void>;
} = {}) {
  const writes: Array<{ sessionId: string; unread: boolean }> = [];
  const errors: Array<{ title: string; description?: string; target?: { sessionId: string } }> = [];
  const successes: string[] = [];
  const pending = options.pending ?? new Set<string>();
  const sessions = [
    summary('root'),
    summary('revision', { revisionRootSessionId: 'root', revisionParentSessionId: 'root' }),
    summary('other', { hasUnread: true }),
  ];
  let refreshes = 0;
  const actions = createSessionNavigationRowActions({
    uiLocale: 'en',
    acquireAutomaticQueryBlock: () => { throw new Error('read state does not block queries'); },
    clearSessionRendererState: () => { throw new Error('read state preserves renderer state'); },
    pendingSessionRowActionsRef: { current: pending },
    refreshSessions: async () => {
      refreshes += 1;
      await options.refreshSessions?.();
      return sessions;
    },
    service: {
      ...createFakeSessionNavigationServices().sessions,
      setUnread: async (sessionId, unread) => {
        writes.push({ sessionId, unread });
        await options.setUnread?.(sessionId, unread);
      },
    },
    sessionsRef: { current: sessions },
    toastApi: {
      success: (title) => { successes.push(title); },
      error: (title, description, _details, target) => { errors.push({ title, description, target }); },
      confirm: async () => { throw new Error('read state does not ask for confirmation'); },
    },
  });
  return { actions, writes, errors, successes, pending, refreshes: () => refreshes };
}

describe('session read-state actions', () => {
  it('marks only the target revision unread or read, refreshing once per action', async () => {
    const h = harness();

    await h.actions.setSessionUnread('revision', true);
    await h.actions.setSessionUnread('revision', false);

    assert.deepEqual(h.writes, [
      { sessionId: 'revision', unread: true },
      { sessionId: 'revision', unread: false },
    ]);
    assert.equal(h.refreshes(), 2);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.successes, []);
    assert.equal(h.pending.size, 0);
  });

  it('reports a failed write and releases the pending guard', async () => {
    const h = harness({ setUnread: async () => { throw new Error('disk write failed'); } });

    await h.actions.setSessionUnread('root', true);

    assert.equal(h.refreshes(), 0);
    assert.equal(h.errors[0]?.title, copy.markUnreadFailedTitle);
    assert.equal(h.errors[0]?.description, copy.actionFallback);
    assert.deepEqual(h.errors[0]?.target, { sessionId: 'root' });
    assert.equal(h.pending.size, 0);
    assert.deepEqual(h.successes, []);
  });

  it('does not change read state during another action on the same row', async () => {
    const pending = new Set(['root:archive']);
    const h = harness({ pending });

    await h.actions.setSessionUnread('root', false);

    assert.deepEqual(h.writes, []);
    assert.equal(h.refreshes(), 0);
    assert.deepEqual(h.errors, []);
    assert.deepEqual([...pending], ['root:archive']);
  });

  it('blocks a second write until the first settles', async () => {
    let release: (() => void) | undefined;
    const h = harness({
      setUnread: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    const first = h.actions.setSessionUnread('root', true);
    assert.deepEqual([...h.pending], ['root:unread']);

    await h.actions.setSessionUnread('root', false);
    assert.deepEqual(h.writes, [{ sessionId: 'root', unread: true }]);
    assert.deepEqual(h.errors, []);

    release?.();
    await first;
    assert.equal(h.pending.size, 0);
    assert.equal(h.refreshes(), 1);
  });

  it('holds the pending guard until the catalog refresh settles', async () => {
    let release: (() => void) | undefined;
    let refreshed: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => { refreshed = resolve; });
    const h = harness({
      refreshSessions: () => new Promise<void>((resolve) => {
        release = resolve;
        refreshed?.();
      }),
    });
    const first = h.actions.setSessionUnread('root', false);
    await refreshStarted;
    assert.deepEqual([...h.pending], ['root:unread']);

    await h.actions.setSessionUnread('root', true);
    assert.deepEqual(h.writes, [{ sessionId: 'root', unread: false }]);
    assert.equal(h.refreshes(), 1);

    release?.();
    await first;
    assert.equal(h.pending.size, 0);
  });

  it('reports a refresh failure and releases the pending guard', async () => {
    const h = harness({
      refreshSessions: async () => { throw new Error('catalog refresh timeout'); },
    });

    await h.actions.setSessionUnread('root', false);

    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0]?.title, copy.markReadFailedTitle);
    assert.match(h.errors[0]?.description ?? '', /Request timed out/);
    assert.deepEqual(h.errors[0]?.target, { sessionId: 'root' });
    assert.equal(h.pending.size, 0);
  });
});
