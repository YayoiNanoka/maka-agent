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

import type { SideConversationWorkspaceState } from '../../../shared/session-workspace-state.js';

export interface SideConversationRecord {
  panel: SideConversationWorkspaceState['panel'];
  hasContent: boolean;
  active: boolean;
}
interface WorkspaceOwner {
  records(): readonly SideConversationRecord[];
  restore(records: readonly SideConversationRecord[]): void;
  remove(ids: ReadonlySet<string>): void;
}
interface PanelOwner {
  capture(): Promise<Pick<SideConversationWorkspaceState, 'draft' | 'companion'>>;
  detach(): void;
  resume(): void;
}
let workspace: WorkspaceOwner | undefined;
const panels = new Map<string, PanelOwner>();
const restoredPanels = new Map<string, SideConversationWorkspaceState>();

export function bindSideConversationWorkspace(owner: WorkspaceOwner): () => void {
  workspace = owner;
  return () => { if (workspace === owner) workspace = undefined; };
}
export function bindSideConversationPanel(id: string, owner: PanelOwner): () => void {
  panels.set(id, owner);
  restoredPanels.delete(id);
  return () => { if (panels.get(id) === owner) panels.delete(id); };
}
export function restoredSideConversationPanel(id: string): SideConversationWorkspaceState | undefined {
  return restoredPanels.get(id);
}
export async function captureSideConversationWorkspace(sessionIds: readonly string[]): Promise<SideConversationWorkspaceState[]> {
  const members = new Set(sessionIds);
  const captured: SideConversationWorkspaceState[] = [];
  for (const record of workspace?.records() ?? []) {
    if (!members.has(record.panel.sourceSessionId)) continue;
    const owner = panels.get(record.panel.id);
    const saved = owner ? await owner.capture() : restoredPanels.get(record.panel.id);
    if (!saved) throw new Error('Side conversation is not ready to transfer');
    const current = workspace?.records().find((entry) => entry.panel.id === record.panel.id);
    if (!current) continue;
    captured.push({ ...structuredClone(current), draft: saved.draft, ...(saved.companion ? { companion: saved.companion } : {}) });
  }
  return captured;
}
export function restoreSideConversationWorkspace(records: readonly SideConversationWorkspaceState[]): void {
  resumeSideConversationWorkspace();
  for (const record of records) restoredPanels.set(record.panel.id, record);
  if (!records.length) return;
  if (!workspace) throw new Error('Side conversation workspace is not ready');
  workspace.restore(records.map((record) => ({ panel: structuredClone(record.panel) as SideConversationWorkspaceState['panel'], hasContent: record.hasContent, active: record.active })));
}
export function detachSideConversationWorkspace(sessionIds: readonly string[]): void {
  const members = new Set(sessionIds);
  for (const record of workspace?.records() ?? []) {
    if (members.has(record.panel.sourceSessionId)) panels.get(record.panel.id)?.detach();
  }
}
export function clearSideConversationWorkspace(sessionIds: readonly string[]): void {
  const members = new Set(sessionIds);
  const ids = new Set((workspace?.records() ?? []).filter((record) => members.has(record.panel.sourceSessionId)).map((record) => record.panel.id));
  detachSideConversationWorkspace(sessionIds);
  for (const id of ids) restoredPanels.delete(id);
  workspace?.remove(ids);
}

export function resumeSideConversationWorkspace(sessionIds?: readonly string[]): void {
  for (const record of workspace?.records() ?? []) {
    if (!sessionIds || sessionIds.includes(record.panel.sourceSessionId)) panels.get(record.panel.id)?.resume();
  }
}
