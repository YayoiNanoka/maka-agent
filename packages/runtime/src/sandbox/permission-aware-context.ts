import { tmpdir as osTmpdir } from 'node:os';
import type { PermissionMode } from '@maka/core/permission';
import type { PermissionProfile } from '@maka/core/permission-profile';
import {
  compilePermissionProfile,
  type CompiledPermissionProfile,
} from '@maka/core/permission-profile-compiler';

import { createDefaultSandboxManager } from './default-sandbox-manager.js';
import type { SandboxManager } from './sandbox-manager.js';
import type {
  SandboxPathContext,
  SandboxPlatform,
  SandboxablePreference,
} from './types.js';

export interface CreatePermissionAwareSandboxContextInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
  sandboxManager?: Pick<SandboxManager, 'transform'>;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
}

export interface PermissionAwareSandboxContext {
  cwd: string;
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  sandboxManager: Pick<SandboxManager, 'transform'>;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext: SandboxPathContext;
}

export interface PermissionAwareSandboxContextAssembly {
  context: PermissionAwareSandboxContext;
  compiledProfile: CompiledPermissionProfile;
}

export function createPermissionAwareSandboxContext(
  input: CreatePermissionAwareSandboxContextInput,
): PermissionAwareSandboxContextAssembly {
  const compiledProfile = compilePermissionProfile({
    mode: input.mode,
    cwd: input.cwd,
    ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
  });
  const pathContext: SandboxPathContext = {
    tmpdir: osTmpdir(),
    slashTmp: '/tmp',
    ...input.pathContext,
    workspaceRoots: compiledProfile.workspaceRoots,
  };

  return {
    compiledProfile,
    context: {
      cwd: input.cwd,
      profile: compiledProfile.profile,
      workspaceRoots: compiledProfile.workspaceRoots,
      sandboxManager: input.sandboxManager ?? createDefaultSandboxManager(),
      ...(input.preference ? { preference: input.preference } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      pathContext,
    },
  };
}

export type FilesystemWorkerProfileOperation = 'read' | 'search' | 'write' | 'edit';

export function deriveFilesystemWorkerProfile(
  activeProfile: PermissionProfile,
  operation: FilesystemWorkerProfileOperation,
): PermissionProfile {
  if (
    activeProfile.type !== 'managed'
    || activeProfile.fileSystem.kind !== 'restricted'
  ) {
    return activeProfile;
  }

  if (operation === 'write' || operation === 'edit') {
    return {
      ...activeProfile,
      network: { kind: 'restricted' },
    };
  }

  return {
    ...activeProfile,
    name: 'read-only',
    fileSystem: {
      ...activeProfile.fileSystem,
      entries: activeProfile.fileSystem.entries.map((entry) => (
        entry.access === 'write' ? { ...entry, access: 'read' as const } : entry
      )),
    },
    network: { kind: 'restricted' },
  };
}
