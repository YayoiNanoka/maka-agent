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
import { test } from 'node:test';
import { createComputerUsePipController } from '../computer-use/pip-window.js';
import type { ParentWindowLike, PipWindowLike } from '../computer-use/pip-electron.js';

test('PiP resolves the session owner before construction and reparents on transfer', () => {
  const main = { isDestroyed: () => false };
  const child = { isDestroyed: () => false };
  let owner: ParentWindowLike = main;
  let createdParent: unknown;
  let movedParent: unknown;
  let subscriptionCount = 0;
  let unsubscribed = 0;
  const resolvedIds: string[] = [];
  const bounds = { x: 20, y: 20, width: 320, height: 200 };
  const window: PipWindowLike = {
    send: () => undefined,
    onReady: () => undefined,
    onGone: () => undefined,
    onLoadFailure: () => undefined,
    onMessage: () => undefined,
    setParentWindow: (parent) => { movedParent = parent; },
    setBounds: () => undefined,
    getBounds: () => bounds,
    showInactive: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    isDestroyed: () => false,
    destroy: () => undefined,
  };
  const pip = createComputerUsePipController({
    resolveBounds: () => bounds,
    resolveParentWindow: (id) => { resolvedIds.push(id); return owner; },
    resolveAnchorRect: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    subscribeAnchorChanges: (id) => {
      assert.equal(id, 'session-A');
      subscriptionCount += 1;
      return () => { unsubscribed += 1; };
    },
    createWindow: (options) => { createdParent = options.parent; return window; },
    cursorPoint: () => ({ x: 0, y: 0 }),
    workAreaFor: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    scheduleFrame: () => () => undefined,
    scheduleHoverCheck: () => () => undefined,
  });
  pip.present({ sessionId: 'session-A', base64: 'image', mimeType: 'image/png', widthPx: 320, heightPx: 200 });
  assert.equal(createdParent, main);
  owner = child;
  pip.refreshOwner();
  assert.equal(movedParent, child);
  assert.deepEqual(resolvedIds, ['session-A', 'session-A']);
  assert.equal(subscriptionCount, 2);
  assert.equal(unsubscribed, 1);
  pip.destroyAll();
});
