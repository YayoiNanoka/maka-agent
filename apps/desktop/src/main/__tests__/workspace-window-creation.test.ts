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
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { createWorkspaceWindowRegistry } from '../workspace-window-registry.js';
import { createWindowRevealGate } from '../window-reveal.js';
import type { MainWindowController } from '../main-window.js';

async function harness() {
  const registry = createWorkspaceWindowRegistry();
  const windows: FakeWindow[] = [];
  let settingsReads = 0;
  let releaseSettings!: () => void;
  const settings = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const closedCounts: number[] = [];
  class Contents extends EventEmitter {
    session = {};
    destroyed = false;
    url = '';
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler() {}
    getURL() { return this.url; }
    executeJavaScript() { return Promise.resolve(); }
    send() {}
  }
  class FakeWindow extends EventEmitter {
    readonly id = windows.length + 1;
    private readonly contents = new Contents();
    destroyed = false;
    visible = false;
    readonly contentView = {};
    get webContents() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super(); windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1240, height: 820 }; }
    getNormalBounds() { return this.getBounds(); }
    async loadURL(url: string) { this.contents.url = url; this.contents.emit('did-finish-load'); this.emit('ready-to-show'); }
    destroy() {
      this.destroyed = true; this.contents.destroyed = true;
      this.contents.emit('destroyed'); this.emit('closed');
    }
  }
  const modules: Record<string, unknown> = {
    electron: { app: {}, BrowserWindow: FakeWindow, nativeTheme: { shouldUseDarkColors: false },
      screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1500, height: 1000 } }] } },
    'node:fs/promises': { mkdir: async () => undefined },
    'node:path': path,
    '@maka/core/settings': { appIconForTheme: () => 'default' },
    './main-window-drop-guard.js': { MAIN_WINDOW_DROP_GUARD_SCRIPT: '' },
    './app-icon-surface.js': { applyInitialWindowAppIcon() {}, readableAppIconPath: () => '' },
    './external-link-guard.js': { isExternalUrl: () => false },
    './window-state.js': { readSavedBounds: async (_root: string, defaults: unknown) => defaults, writeSavedBounds: async () => undefined, SAFE_MIN_WIDTH: 600, SAFE_MIN_HEIGHT: 400 },
    './browser/controller.js': {}, './browser/view-manager.js': {},
    './main-window-permission-policy.js': { installMainWindowPermissionPolicy() {} },
    './main-renderer-loader.js': { resolveMainRendererEntry: () => ({ url: 'http://localhost/index.html' }), loadMainRenderer: (window: FakeWindow) => window.loadURL('http://localhost/index.html') },
    './main-renderer-dev-cache.js': { clearDevRendererHttpCache: async () => undefined },
    './main-renderer-process-gone.js': { observeMainRendererProcessGone() {} },
    './theme-source.js': { isDarkAppearance: () => false, toNativeThemeSource: () => 'system' },
    './window-reveal.js': { createWindowRevealGate },
    './windows-maximize-renderer-sync.js': { createWindowsMaximizeRendererSync: () => () => undefined },
    './auxiliary-window-registry.js': { auxiliaryWindowRegistry: { renderers: () => [] } },
    './workspace-window-registry.js': { workspaceWindowRegistry: registry },
    '../shared/runtime-host-identity.js': {},
  };
  const source = await readFile(fileURLToPath(new URL('../../../src/main/main-window.ts', import.meta.url)), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022', define: { 'import.meta.dirname': JSON.stringify('/virtual/main') } });
  const module = { exports: {} as { createMainWindowController: (deps: unknown) => MainWindowController } };
  runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected import ${id}`); return modules[id]; },
    process: { platform: 'linux', env: {} }, setTimeout, clearTimeout, console,
  });
  const controller = module.exports.createMainWindowController({
    workspaceRoot: '/virtual', e2eFixture: null, revealMode: 'hidden',
    settingsStore: { get: async () => { settingsReads += 1; await settings; return { appearance: { theme: 'auto' } }; } },
    onRendererProcessGone() {},
    onClosed: () => { closedCounts.push(registry.entries().length); },
  });
  return { controller, registry, windows, releaseSettings, closedCounts, settingsReads: () => settingsReads };
}

test('concurrent main creation shares the asynchronous construction and one registered native window', async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const first = h.controller.createWindow(signal);
  const second = h.controller.createWindow(signal);
  assert.equal(first, second);
  assert.equal(h.settingsReads(), 1);
  assert.equal(h.windows.length, 0);
  h.releaseSettings();
  await Promise.all([first, second]);
  assert.equal(h.windows.length, 1);
  assert.equal(h.registry.main()?.window, h.windows[0]);
  assert.equal(h.controller.browserWindow(), h.windows[0]);
  assert.equal(h.registry.main()?.controller.browserWindow(), h.windows[0]);
  await h.controller.createWindow(signal);
  assert.equal(h.windows.length, 1);
  h.windows[0]!.destroy();
  await Promise.all([h.controller.createWindow(signal), h.controller.createWindow(signal)]);
  assert.equal(h.windows.length, 2);
  assert.equal(h.registry.main()?.window, h.windows[1]);
});

test('closing the last session window invokes the shared workspace lifecycle callback', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);
  h.windows[0]!.destroy();
  assert.deepEqual(h.closedCounts, [1]);
  assert.equal(h.controller.hasOpenWindows(), true);
  h.windows[1]!.destroy();
  assert.deepEqual(h.closedCounts, [1, 0]);
  assert.equal(h.controller.hasOpenWindows(), false);
});
