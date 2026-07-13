import type { PermissionMode } from '@maka/core/permission';

import type { ShellRunBashInput } from '../shell-run-contract.js';
import { createPermissionAwareSandboxContext } from './permission-aware-context.js';
import type { PermissionAwareSandboxContext } from './permission-aware-context.js';
import type { SandboxManager } from './sandbox-manager.js';
import type {
  SandboxPathContext,
  SandboxPlatform,
  SandboxablePreference,
} from './types.js';

export interface SandboxSessionHeader {
  cwd: string;
  permissionMode: PermissionMode;
}

export interface CreateSessionSandboxContextProviderInput {
  readHeader: (sessionId: string) => Promise<SandboxSessionHeader>;
  canonicalizeCwd: (cwd: string) => Promise<string>;
  sandboxManager: Pick<SandboxManager, 'transform'>;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
}

export type ShellRunSandboxContextFailureReason =
  | 'session_not_found'
  | 'invalid_cwd'
  | 'profile_compile_failed';

export type ShellRunSandboxContextResult =
  | { ok: true; context: PermissionAwareSandboxContext }
  | {
      ok: false;
      reason: ShellRunSandboxContextFailureReason;
      message: string;
    };

export type ShellRunSandboxContextProvider = (
  input: Pick<ShellRunBashInput, 'sessionId'>,
) => Promise<ShellRunSandboxContextResult>;

export function createSessionSandboxContextProvider(
  input: CreateSessionSandboxContextProviderInput,
): ShellRunSandboxContextProvider {
  return async (shellInput): Promise<ShellRunSandboxContextResult> => {
    let header: SandboxSessionHeader;
    try {
      header = await input.readHeader(shellInput.sessionId);
    } catch (error) {
      return failure('session_not_found', error);
    }

    let cwd: string;
    try {
      cwd = await input.canonicalizeCwd(header.cwd);
    } catch (error) {
      return failure('invalid_cwd', error);
    }

    try {
      return {
        ok: true,
        context: createPermissionAwareSandboxContext({
          mode: header.permissionMode,
          cwd,
          workspaceRoots: [cwd],
          sandboxManager: input.sandboxManager,
          ...(input.preference ? { preference: input.preference } : {}),
          ...(input.platform ? { platform: input.platform } : {}),
          ...(input.pathContext ? { pathContext: input.pathContext } : {}),
        }).context,
      };
    } catch (error) {
      return failure('profile_compile_failed', error);
    }
  };
}

function failure(
  reason: ShellRunSandboxContextFailureReason,
  error: unknown,
): ShellRunSandboxContextResult {
  return {
    ok: false,
    reason,
    message: error instanceof Error ? error.message : String(error),
  };
}
