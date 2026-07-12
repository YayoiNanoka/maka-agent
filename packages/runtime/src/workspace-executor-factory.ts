import type { PermissionMode } from '@maka/core/permission';
import type { CompiledPermissionProfile } from '@maka/core/permission-profile-compiler';
import { buildBuiltinTools, type BuildBuiltinToolsOptions } from './builtin-tools.js';
import type { SandboxPathContext, SandboxPlatform, SandboxablePreference } from './sandbox/index.js';
import { createPermissionAwareSandboxContext } from './sandbox/permission-aware-context.js';
import {
  createLocalWorkspaceExecutor,
  ProfileEnforcedWorkspaceExecutor,
  SandboxedCommandWorkspaceExecutor,
  type WorkspaceCommandRunner,
  type WorkspaceCommandSandboxManager,
  type WorkspaceBashExecutor,
  type WorkspaceExecutor,
  type WorkspaceFileOperations,
} from './workspace-executor.js';

export interface CreatePermissionAwareWorkspaceExecutorInput {
  mode: PermissionMode;
  cwd: string;
  workspaceRoots?: readonly string[];
  inner?: WorkspaceExecutor;
  sandboxManager?: WorkspaceCommandSandboxManager;
  sandboxPreference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
  runProcess?: WorkspaceCommandRunner;
}

export interface PermissionAwareWorkspaceExecutorAssembly {
  commandExecutor: WorkspaceBashExecutor;
  fileOperations: WorkspaceFileOperations;
  /** Compatibility composite; new code should use commandExecutor/fileOperations. */
  executor: WorkspaceExecutor;
  compiledProfile: CompiledPermissionProfile;
  sandboxManager: WorkspaceCommandSandboxManager;
}

export interface BuildPermissionAwareBuiltinToolsInput
  extends CreatePermissionAwareWorkspaceExecutorInput,
    Omit<BuildBuiltinToolsOptions, 'executor'> {}

export interface PermissionAwareBuiltinToolsAssembly extends PermissionAwareWorkspaceExecutorAssembly {
  tools: ReturnType<typeof buildBuiltinTools>;
}

export function createPermissionAwareWorkspaceExecutor(
  input: CreatePermissionAwareWorkspaceExecutorInput,
): PermissionAwareWorkspaceExecutorAssembly {
  const builtContext = createPermissionAwareSandboxContext({
    mode: input.mode,
    cwd: input.cwd,
    ...(input.workspaceRoots ? { workspaceRoots: input.workspaceRoots } : {}),
    ...(input.sandboxManager ? { sandboxManager: input.sandboxManager } : {}),
    ...(input.sandboxPreference ? { preference: input.sandboxPreference } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.pathContext ? { pathContext: input.pathContext } : {}),
  });
  const { compiledProfile, context } = builtContext;
  const workspaceRoots = compiledProfile.workspaceRoots;
  const sandboxManager = context.sandboxManager;
  const pathContext = context.pathContext;

  const local = input.inner ?? createLocalWorkspaceExecutor();
  const sandboxedCommands = new SandboxedCommandWorkspaceExecutor({
    inner: local,
    getSandboxContext: () => ({
      profile: context.profile,
      workspaceRoots,
      sandboxManager,
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
      pathContext,
    }),
    ...(input.runProcess ? { runProcess: input.runProcess } : {}),
  });
  const executor = new ProfileEnforcedWorkspaceExecutor({
    inner: sandboxedCommands,
    getProfileContext: () => ({
      profile: compiledProfile.profile,
      workspaceRoots,
      pathContext,
    }),
  });

  return {
    commandExecutor: sandboxedCommands,
    fileOperations: executor,
    executor,
    compiledProfile,
    sandboxManager,
  };
}

export function buildPermissionAwareBuiltinTools(
  input: BuildPermissionAwareBuiltinToolsInput,
): PermissionAwareBuiltinToolsAssembly {
  const assembly = createPermissionAwareWorkspaceExecutor(input);
  return {
    ...assembly,
    tools: buildBuiltinTools({
      ...(input.shellRuns ? { shellRuns: input.shellRuns } : {}),
      commandExecutor: assembly.commandExecutor,
      fileOperations: assembly.fileOperations,
    }),
  };
}
