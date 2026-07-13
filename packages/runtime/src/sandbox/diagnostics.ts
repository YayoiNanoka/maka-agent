import { isAbsolute, normalize } from 'node:path';
import type { PermissionProfile } from '@maka/core/permission-profile';

import type {
  ActiveSandboxCapabilities,
  ActiveSandboxCapability,
  SandboxCapabilityUnavailableReason,
} from './active-capabilities.js';
import type { PermissionAwareSandboxContext } from './permission-aware-context.js';
import type { SandboxType } from './types.js';

export type SandboxDiagnosticFileSystemMode =
  | 'read-only'
  | 'workspace-write'
  | 'unrestricted'
  | 'custom-restricted'
  | 'external'
  | 'disabled';

export type SandboxDiagnosticNetworkMode = 'restricted' | 'enabled' | 'unmanaged';

export interface SandboxDiagnosticCapability {
  readonly status: ActiveSandboxCapability['status'];
  readonly backend: SandboxType;
  readonly reason?: SandboxCapabilityUnavailableReason;
}

export interface SandboxDiagnosticsSnapshot {
  readonly schemaVersion: 1;
  readonly profile: {
    readonly name: string;
    readonly type: PermissionProfile['type'];
    readonly fileSystem: SandboxDiagnosticFileSystemMode;
    readonly network: SandboxDiagnosticNetworkMode;
    readonly cwd: string;
    readonly workspaceRoots: readonly string[];
    readonly protectedMetadata: readonly string[];
  };
  readonly capabilities: {
    readonly command: SandboxDiagnosticCapability;
    readonly filesystem: SandboxDiagnosticCapability;
  };
}

export interface SandboxRunTraceProjection {
  readonly schemaVersion: 1;
  readonly profile: {
    readonly name: string;
    readonly type: PermissionProfile['type'];
    readonly fileSystem: SandboxDiagnosticFileSystemMode;
    readonly network: SandboxDiagnosticNetworkMode;
    readonly protectedMetadata: readonly string[];
  };
  readonly capabilities: {
    readonly command: SandboxDiagnosticCapability;
    readonly filesystem: SandboxDiagnosticCapability;
  };
}

export interface BuildSandboxDiagnosticsSnapshotInput {
  context: Pick<PermissionAwareSandboxContext, 'cwd' | 'profile' | 'workspaceRoots'>;
  capabilities: ActiveSandboxCapabilities;
}

export function buildSandboxDiagnosticsSnapshot(
  input: BuildSandboxDiagnosticsSnapshotInput,
): SandboxDiagnosticsSnapshot {
  const { context, capabilities } = input;
  const profileName = context.profile.name ?? context.profile.type;
  if (capabilities.profileName !== profileName) {
    throw new Error(
      `Sandbox diagnostics profile mismatch: context=${profileName}, capabilities=${capabilities.profileName}.`,
    );
  }

  const cwd = requireCanonicalAbsolutePath(context.cwd, 'cwd');
  const workspaceRoots = deduplicateRoots(context.workspaceRoots);
  if (workspaceRoots.length === 0) {
    throw new Error('Sandbox diagnostics require at least one workspace root.');
  }
  if (!workspaceRoots.some((root) => pathWithinRoot(cwd, root))) {
    throw new Error('Sandbox diagnostics cwd must be contained by a workspace root.');
  }

  return {
    schemaVersion: 1,
    profile: {
      name: profileName,
      type: context.profile.type,
      fileSystem: summarizeFileSystem(context.profile),
      network: summarizeNetwork(context.profile),
      cwd,
      workspaceRoots,
      protectedMetadata: protectedMetadataNames(context.profile),
    },
    capabilities: {
      command: summarizeCapability(capabilities.command, 'command'),
      filesystem: summarizeCapability(capabilities.filesystem, 'filesystem'),
    },
  };
}

export function toSandboxRunTraceProjection(
  snapshot: SandboxDiagnosticsSnapshot,
): SandboxRunTraceProjection {
  return {
    schemaVersion: snapshot.schemaVersion,
    profile: {
      name: snapshot.profile.name,
      type: snapshot.profile.type,
      fileSystem: snapshot.profile.fileSystem,
      network: snapshot.profile.network,
      protectedMetadata: [...snapshot.profile.protectedMetadata],
    },
    capabilities: {
      command: { ...snapshot.capabilities.command },
      filesystem: { ...snapshot.capabilities.filesystem },
    },
  };
}

function summarizeFileSystem(profile: PermissionProfile): SandboxDiagnosticFileSystemMode {
  if (profile.type === 'disabled') return 'disabled';
  if (profile.type === 'external') return 'external';
  if (profile.fileSystem.kind === 'unrestricted') return 'unrestricted';
  if (profile.fileSystem.kind === 'external_sandbox') return 'external';

  const hasWrite = profile.fileSystem.entries.some((entry) => entry.access === 'write');
  if (!hasWrite) return 'read-only';
  const writesWorkspaceRoots = profile.fileSystem.entries.some(
    (entry) => entry.kind === 'special'
      && entry.special === ':workspace_roots'
      && entry.access === 'write',
  );
  return writesWorkspaceRoots ? 'workspace-write' : 'custom-restricted';
}

function summarizeNetwork(profile: PermissionProfile): SandboxDiagnosticNetworkMode {
  return profile.type === 'disabled' ? 'unmanaged' : profile.network.kind;
}

function protectedMetadataNames(profile: PermissionProfile): readonly string[] {
  if (profile.type !== 'managed') return [];
  return [...(profile.fileSystem.protectedMetadata?.names ?? [])];
}

function summarizeCapability(
  capability: ActiveSandboxCapability,
  domain: 'command' | 'filesystem',
): SandboxDiagnosticCapability {
  const { status, sandboxType: backend, reason } = capability;
  if (status === 'available' && backend === 'none') {
    throw new Error(`Sandbox diagnostics ${domain} capability cannot be available with backend none.`);
  }
  if ((status === 'not_required' || status === 'external') && backend !== 'none') {
    throw new Error(`Sandbox diagnostics ${domain} capability ${status} must use backend none.`);
  }
  if (status === 'unavailable' && !reason) {
    throw new Error(`Sandbox diagnostics ${domain} unavailable capability requires a reason.`);
  }
  if (status !== 'unavailable' && reason) {
    throw new Error(`Sandbox diagnostics ${domain} capability reason is only valid when unavailable.`);
  }
  return {
    status,
    backend,
    ...(reason ? { reason } : {}),
  };
}

function deduplicateRoots(roots: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of roots) {
    const root = requireCanonicalAbsolutePath(value, 'workspace root');
    if (seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }
  return result;
}

function requireCanonicalAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\r\n\t]/.test(value)) {
    throw new Error(`Sandbox diagnostics ${label} must be a canonical absolute path.`);
  }
  const normalized = trimTrailingSeparator(normalize(value));
  if (normalized !== trimTrailingSeparator(value)) {
    throw new Error(`Sandbox diagnostics ${label} must be normalized before snapshot construction.`);
  }
  return normalized;
}

function pathWithinRoot(path: string, root: string): boolean {
  if (root === '/') return path.startsWith('/');
  return path === root || path.startsWith(`${root}/`);
}

function trimTrailingSeparator(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}
