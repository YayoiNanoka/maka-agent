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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';
import type { SessionWindowContext, SessionWindowNavigation } from '../ports.js';
import { useSessionWindowServices } from '../services-context.js';
import { bootstrapSessionWindow, createSessionWindowNavigator } from '../controller/session-window-navigation.js';
import { sessionWindowCopy } from '../copy.js';

export interface SessionWindowProjection {
  readonly context: SessionWindowContext;
  readonly lifecycle: { current?: { openWorkspace(sessionId: string, isCurrent: () => boolean, activate: () => void): Promise<void> } };
  readonly frozen: boolean;
  readonly returning: boolean;
  readonly standalone: boolean;
  setFrozen(frozen: boolean): void;
  setRestoring(restoring: boolean): void;
  bootstrap(refresh: () => Promise<SessionSummary[]>, revision: () => number, open: (id: string) => void): Promise<void>;
  openSession(navigation: SessionWindowNavigation, activate: () => void): Promise<boolean>;
  openInNewWindow(sessionId: string): Promise<void>;
  openInMainWindow(): void;
  commandMain(command: 'newTask' | 'openSettings' | 'openHelp'): void;
}

/** Resolves the sender's role before any conversation or navigation controller mounts. */
export function SessionWindowRoot(props: { children(window: SessionWindowProjection): ReactNode }) {
  const services = useSessionWindowServices();
  const locale = useUiLocale();
  const toast = useToast();
  const lifecycle = useRef<{ openWorkspace(sessionId: string, isCurrent: () => boolean, activate: () => void): Promise<void> }>(undefined);
  const blocked = useRef(false);
  const [context, setContext] = useState<SessionWindowContext>();
  const [failure, setFailure] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [returning, setReturning] = useState(false);
  const copy = sessionWindowCopy(locale);
  useEffect(() => {
    let disposed = false;
    void services.context().then(
      (next) => { if (!disposed) setContext(next); },
      () => { if (!disposed) setFailure(true); },
    );
    return () => { disposed = true; };
  }, [services]);
  const navigator = useMemo(() => createSessionWindowNavigator({
    route: services.routeSession,
    openWorkspace: async (sessionId, isCurrent, activate) => {
      if (lifecycle.current) await lifecycle.current.openWorkspace(sessionId, isCurrent, activate);
      else if (isCurrent()) activate();
    },
    blocked: () => blocked.current,
  }), [services]);
  const commands = useMemo(() => {
    const report = (error: unknown) => toast.error(copy.failed, error instanceof Error ? error.message : String(error));
    return {
      setFrozen(value: boolean) {
        if (value) navigator.invalidate();
        blocked.current = value;
        setFrozen(value);
      },
      bootstrap(refresh: () => Promise<SessionSummary[]>, revision: () => number, open: (id: string) => void) {
        return bootstrapSessionWindow({ kind: context?.kind, refresh, revision, open });
      },
      openSession(navigation: SessionWindowNavigation, activate: () => void) {
        return navigator.open(navigation, activate).catch((error) => { report(error); return false; });
      },
      async openInNewWindow(sessionId: string) {
        try { await services.openSessionWindow(sessionId); } catch (error) { report(error); }
      },
      openInMainWindow() {
        setReturning(true);
        void services.openInMainWindow().catch(report).finally(() => setReturning(false));
      },
      commandMain(command: 'newTask' | 'openSettings' | 'openHelp') {
        void services.commandMain(command).catch(report);
      },
    };
  }, [services, toast, copy.failed, context?.kind, navigator]);
  if (failure) return <div role="alert">{copy.failed}</div>;
  if (!context) return null;
  return props.children({ context, lifecycle, frozen: frozen || restoring, setRestoring, returning, standalone: context.kind === 'session', ...commands });
}
