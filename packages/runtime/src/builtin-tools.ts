// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  bashSandboxPermissionsSchema,
  buildManagedBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  shapeTerminalResult,
  withShellGuidance,
} from './shell-tools.js';
import {
  compilePermissionProfile,
  type PermissionProfile,
} from '@maka/core';
import { computeEditedSource } from './edit-replace.js';
import type { ShellRunLauncher } from './shell-tools.js';
import { defaultShellPlan, type ShellPlan } from './shell-detect.js';
import type {
  BackgroundTaskStopper,
  PtyControlWriter,
  RuntimeResourceReader,
} from './shell-run-contract.js';
import {
  type WorkspaceExecResult,
  type WorkspaceBashExecutor,
  type WorkspaceExecutor,
  type WorkspaceFileOperations,
  createLocalWorkspaceExecutor,
} from './workspace-executor.js';

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
import { withFileWriteLock } from './file-write-lock.js';
import {
  planDeclaredBashAdditionalPermission,
  planFileToolAdditionalPermission,
  type AdditionalPermissionPlanningContext,
} from './additional-permissions.js';
import {
  planDeclaredBashSandboxEscalation,
  assertSandboxEscalationGrantForExecution,
} from './sandbox-escalation.js';
import { linuxExecutableRoots } from './sandbox/linux-sandbox.js';
import type { SandboxEnforcementManager, SandboxPlatform } from './sandbox/types.js';
import type { ChildFdInput } from './child-fd-input.js';

// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

export interface BuildBuiltinToolsOptions {
  shellRuns?: ShellRunLauncher;
  runtimeResources?: RuntimeResourceReader;
  backgroundTasks?: BackgroundTaskStopper;
  ptyControls?: PtyControlWriter;
  commandExecutor?: WorkspaceBashExecutor;
  fileOperations?: WorkspaceFileOperations;
  executor?: WorkspaceExecutor;
  additionalPermissionPlanningContext?: AdditionalPermissionPlanningContext;
  /** Shell that runs Bash commands. Defaults to the process-wide detected shell. */
  shell?: ShellPlan;
  permissionProfile?: PermissionProfile;
  sandboxManager?: SandboxEnforcementManager;
  /** Test/embedding override. Production callers use the current process platform. */
  sandboxPlatform?: SandboxPlatform;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions = {}): MakaTool[] {
  const executor = options.executor ?? createLocalWorkspaceExecutor();
  const commandExecutor = options.commandExecutor ?? executor;
  const fileOperations = options.fileOperations ?? executor;
  const commandExecutionFacts = commandExecutor.facts;
  const fileExecutionFacts = fileOperations.facts;
  const readDescription = options.runtimeResources
    ? 'Read a file by path, or read a runtime resource by ref. Paths outside the active profile require one-time approval.'
    : 'Read a file by path. Paths outside the active profile require one-time approval.';
  const fileReadParameters = z.object({
    path: z.string().describe('A file path relative to the session cwd'),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }).strict();
  const readParameters = options.runtimeResources
    ? z.union([
        fileReadParameters,
        z.object({
          ref: z.string().describe('A runtime resource ref returned by another tool'),
        }).strict(),
      ])
    : fileReadParameters;
  const shell = options.shell ?? defaultShellPlan();
  const sandboxPlatform = options.sandboxPlatform ?? process.platform;
  const bashTools = options.shellRuns
    ? [buildManagedBashTool(options.shellRuns, {
        executionFacts: commandExecutionFacts,
        shell,
        ...(options.sandboxManager ? {
          sandbox: sandboxAvailabilityResolver(
            options.sandboxManager,
            options.permissionProfile,
            sandboxPlatform,
          ),
          transformCommand: ({ command, pty, ctx }) => sandboxCommand(
            options.sandboxManager!,
            options.permissionProfile,
            sandboxPlatform,
            command,
            pty,
            ctx,
          ),
        } : {}),
        ...(options.additionalPermissionPlanningContext ? {
          planAdditionalPermissions: (args, context) => planDeclaredBashAdditionalPermission({
            declaration: args.sandbox_permissions,
            cwd: context.cwd,
            mode: context.mode,
            command: args.command,
            context: options.additionalPermissionPlanningContext!,
          }),
          planSandboxEscalation: (args, context) => planDeclaredBashSandboxEscalation({
            declaration: args.sandbox_permissions,
            cwd: context.cwd,
            mode: context.mode,
            command: args.command,
            args: context.args,
            ...(context.recentSandboxDenial ? { recentSandboxDenial: true } : {}),
          }),
        } : {}),
      })]
    : [buildExecutorBashTool(commandExecutor, shell, {
        ...(options.permissionProfile ? { permissionProfile: options.permissionProfile } : {}),
        ...(options.sandboxManager ? { sandboxManager: options.sandboxManager } : {}),
        sandboxPlatform,
      }, options.additionalPermissionPlanningContext)];
  const backgroundTools = [
    ...(options.backgroundTasks ? [buildStopBackgroundTaskTool(options.backgroundTasks)] : []),
    ...(options.ptyControls ? [buildWriteStdinTool(options.ptyControls)] : []),
  ];
  return [
    ...bashTools,
    ...backgroundTools,
    {
      name: 'Read',
      activityKind: 'read',
      description: readDescription,
      parameters: readParameters,
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: (args, context) => ('ref' in args
          ? { kind: 'not_required' as const }
          : planFileToolAdditionalPermission({
              toolName: 'Read',
              path: args.path,
              cwd: context.cwd,
              mode: context.mode,
              args: context.args,
              context: options.additionalPermissionPlanningContext!,
            })),
      } : {}),
      impl: async (input, { cwd, sessionId, abortSignal, permissionContext }) => {
        if ('ref' in input) {
          const { ref } = input;
          if (classifyRuntimeResourceRef(ref) !== 'runtime') {
            throw new Error(`Unsupported runtime resource ref: ${ref}`);
          }
          if (!options.runtimeResources) throw new Error('Runtime resources are not available in this toolset');
          return await options.runtimeResources.readRuntimeResource(sessionId, ref, abortSignal);
        }

        const { path, offset, limit } = input;
        const runtimeRef = classifyRuntimeResourceRef(path);
        if (runtimeRef === 'unsupported') throw new Error(`Unsupported runtime resource ref: ${path}`);
        if (runtimeRef === 'runtime') {
          throw new Error('Runtime resources must be read with the ref parameter, not path');
        }
        return await fileOperations.read({
          cwd,
          path,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
          permissionContext,
        });
      },
    },
    {
      name: 'Write',
      activityKind: 'edit',
      description: 'Write content to a file (creates or overwrites). Paths outside the active profile require one-time approval.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Write', path, cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ path, content }, { cwd, permissionContext }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path, permissionContext });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.write({ cwd, path, content, permissionContext });
        });
      },
    },
    {
      name: 'Edit',
      activityKind: 'edit',
      description:
        'Replace old_string with new_string in a file. Prefers an exact, unique match; '
        + 'if exact fails it tolerates limited whitespace/indentation/escape drift in old_string, '
        + 'but only when the match is unambiguous (otherwise it errors — re-read and retry with exact text). '
        + 'new_string is written verbatim, so provide the exact final text/indentation you want. '
        + 'Errors if old_string is not found or not unique. Paths outside the active profile require one-time approval.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Edit', path, cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ path, old_string, new_string }, { cwd, permissionContext }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path, permissionContext });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.edit({
            cwd,
            path,
            oldString: old_string,
            newString: new_string,
            permissionContext,
          });
        });
      },
    },
    {
      name: 'FormatJson',
      activityKind: 'edit',
      description:
        'Validate and normalize a JSON file in place. Reads the file at `path`, '
        + 'parses it (throwing a parse-error hint on invalid JSON), optionally sorts '
        + 'object keys lexicographically, and rewrites it with canonical 2-space '
        + 'indentation. Returns only a diagnostic (valid + byte delta) — the content '
        + 'is never round-tripped back through the prompt. Useful for config hygiene '
        + 'after a Write.',
      parameters: z.object({
        path: z.string().describe('Path to the JSON file to validate and normalize, relative to the session cwd.'),
        sort_keys: z.boolean().optional()
          .describe('Sort object keys lexicographically; default false.'),
      }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'FormatJson', path, cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ path, sort_keys }, { cwd, permissionContext }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path, permissionContext });
        return await withFileWriteLock(key, async () => {
          const { content: original } = await fileOperations.read({ cwd, path, permissionContext });
          const bytesBefore = Buffer.byteLength(original, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch (e) {
            return {
              ok: false,
              valid: false,
              error: `FormatJson: invalid JSON: ${(e as Error).message}`,
              path,
              bytesBefore,
              byteDelta: 0,
              changed: false,
            };
          }
          const value = sort_keys ? sortKeysDeep(parsed) : parsed;
          const formatted = JSON.stringify(value, null, 2);
          const { path: resolvedPath, bytes: bytesAfter } = await fileOperations.write({
            cwd,
            path,
            content: formatted,
            permissionContext,
          });
          return {
            ok: true,
            path: resolvedPath,
            valid: true,
            bytesBefore,
            bytesAfter,
            byteDelta: bytesAfter - bytesBefore,
            changed: formatted !== original,
          };
        });
      },
    },
    {
      name: 'Glob',
      activityKind: 'search',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order). Search roots outside the active profile require one-time approval.',
      parameters: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ cwd: relCwd }, context) => planFileToolAdditionalPermission({
          toolName: 'Glob', path: relCwd ?? '.', cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ pattern, cwd: relCwd }, { cwd, permissionContext }) => {
        assertRelativeGlobPattern(pattern);
        return await fileOperations.glob({
          cwd,
          path: relCwd ?? '.',
          pattern,
          limit: 200,
          permissionContext,
        });
      },
    },
    {
      name: 'Grep',
      activityKind: 'search',
      description: 'Search file contents with a regex via ripgrep. Search roots outside the active profile require one-time approval.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Grep', path: path ?? '.', cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ pattern, path, glob }, { cwd, abortSignal, permissionContext }) => {
        // Self-bound: ripgrep finishes in well under a second normally, but a
        // pathological tree (network mount, /proc, a FIFO) could hang it. The
        // stream watchdog no longer caps tool execution, so each spawning tool
        // must carry its own wall-clock timeout and honour the turn's abort.
        return await fileOperations.grep({
          cwd,
          pattern,
          path: path ?? '.',
          ...(glob ? { glob } : {}),
          maxCountPerFile: 50,
          limit: 200,
          timeoutMs: GREP_TIMEOUT_MS,
          ...(abortSignal ? { abortSignal } : {}),
          permissionContext,
        });
      },
    },
  ];
}

interface ExecutorBashSandboxOptions {
  permissionProfile?: PermissionProfile;
  sandboxManager?: SandboxEnforcementManager;
  sandboxPlatform: SandboxPlatform;
}

function buildExecutorBashTool(
  executor: WorkspaceBashExecutor,
  shell: ShellPlan,
  sandboxOptions: ExecutorBashSandboxOptions,
  planningContext?: AdditionalPermissionPlanningContext,
): MakaTool {
  return {
    name: 'Bash',
    activityKind: 'command',
    description: withShellGuidance('Run a shell command in the session cwd.', shell)
      + ' Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
      sandbox_permissions: bashSandboxPermissionsSchema
        .describe('Optional one-call permission request. Prefer with_additional_permissions for minimal access; use require_escalated only when sandboxed execution cannot work. Approval is routed by the active permission mode.')
        .optional(),
    }),
    permissionRequired: true,
    sandboxRequirement: 'command',
    executionFacts: executor.facts,
    ...(planningContext ? {
      planAdditionalPermissions: (args, context) => planDeclaredBashAdditionalPermission({
        declaration: args.sandbox_permissions,
        cwd: context.cwd,
        mode: context.mode,
        command: args.command,
        context: planningContext,
      }),
      planSandboxEscalation: (args, context) => planDeclaredBashSandboxEscalation({
        declaration: args.sandbox_permissions,
        cwd: context.cwd,
        mode: context.mode,
        command: args.command,
        args: context.args,
        ...(context.recentSandboxDenial ? { recentSandboxDenial: true } : {}),
      }),
    } : {}),
    ...(sandboxOptions.sandboxManager ? {
      sandbox: sandboxAvailabilityResolver(
        sandboxOptions.sandboxManager,
        sandboxOptions.permissionProfile,
        sandboxOptions.sandboxPlatform,
      ),
    } : {}),
    impl: async ({ command, timeout_ms }, ctx) => {
      const { cwd, abortSignal, emitOutput, permissionContext } = ctx;
      const timeout = timeout_ms ?? 120_000;
      const transformed = sandboxOptions.sandboxManager
        ? sandboxCommand(
            sandboxOptions.sandboxManager,
            sandboxOptions.permissionProfile,
            sandboxOptions.sandboxPlatform,
            command,
            false,
            ctx,
          )
        : undefined;
      const result = await executor.exec({
        command,
        cwd: transformed?.cwd ?? cwd,
        ...(transformed ? { argv: transformed.argv } : {}),
        ...(transformed?.env ? { env: transformed.env } : {}),
        ...(transformed?.fdInputs ? { fdInputs: transformed.fdInputs } : {}),
        timeoutMs: timeout,
        ...(abortSignal ? { abortSignal } : {}),
        emitOutput,
        permissionContext,
        shell,
      });
      if (result.timedOut) throw terminalError(`Command timed out after ${timeout}ms`, result, 124);
      if (result.aborted) throw terminalError('Command aborted', result, 130);
      if (result.exitCode !== 0) {
        throw terminalError(`Command failed with exit code ${result.exitCode}`, result, result.exitCode);
      }
      return shapeTerminalResult({ cwd, command, result });
    },
  };
}

function sandboxAvailabilityResolver(
  manager: SandboxEnforcementManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
): NonNullable<MakaTool['sandbox']> {
  return ({ permissionMode, cwd, args }) => {
    const effective = effectivePermissionProfile(explicitProfile, permissionMode, cwd);
    if (isPtyBashArgs(args) && profileRequiresSandbox(effective.profile)) {
      return { platformSandboxAvailable: false };
    }
    return {
      platformSandboxAvailable: manager.canEnforce({
        profile: effective.profile,
        platform,
      }),
    };
  };
}

function sandboxCommand(
  manager: SandboxEnforcementManager,
  explicitProfile: PermissionProfile | undefined,
  platform: SandboxPlatform,
  command: string,
  pty: boolean,
  ctx: MakaToolContext,
): {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly ChildFdInput[];
  sandboxType?: import('./sandbox/types.js').SandboxType;
} | undefined {
  const effective = effectivePermissionProfile(
    explicitProfile,
    ctx.permissionMode ?? 'ask',
    ctx.cwd,
  );
  const escalationGrant = ctx.permissionContext?.sandboxEscalationGrant;
  if (escalationGrant) {
    assertSandboxEscalationGrantForExecution({
      grant: escalationGrant,
      command,
      cwd: ctx.cwd,
    });
    return {
      argv: buildShellSpawnArgv(command),
      cwd: ctx.cwd,
      env: { ...process.env },
      sandboxType: 'none',
    };
  }
  if (pty) {
    if (profileRequiresSandbox(effective.profile)) {
      throw new Error('PTY Bash is unavailable while the active permission profile requires command sandboxing.');
    }
    return undefined;
  }
  if (!manager.canEnforce({ profile: effective.profile, platform })) return undefined;

  const env = { ...process.env };
  const result = manager.transform({
    platform,
    command: {
      program: '/bin/sh',
      args: ['-c', command],
      cwd: ctx.cwd,
      env,
      profile: effective.profile,
      pathContext: {
        workspaceRoots: effective.workspaceRoots,
        tmpdir: tmpdir(),
        slashTmp: '/tmp',
        ...(platform === 'linux' ? {
          minimalRoots: linuxExecutableRoots({
            execPath: process.execPath,
            path: env.PATH,
          }),
        } : {}),
      },
    },
    ...(ctx.permissionContext?.additionalGrant
      ? { additionalPermissions: ctx.permissionContext.additionalGrant.profile }
      : {}),
  });
  if (!result.ok) {
    throw new Error(result.message ?? `Sandbox transform failed: ${result.reason}`);
  }
  return {
    argv: result.exec.argv,
    cwd: result.exec.cwd,
    ...(result.exec.env ? { env: { ...result.exec.env } } : {}),
    ...(result.exec.fdInputs ? { fdInputs: result.exec.fdInputs } : {}),
    sandboxType: result.exec.sandboxType,
  };
}

function profileRequiresSandbox(profile: PermissionProfile): boolean {
  return profile.type === 'managed' && profile.fileSystem.kind === 'restricted';
}

function buildShellSpawnArgv(command: string): readonly string[] {
  return ['/bin/sh', '-c', command];
}

function effectivePermissionProfile(
  explicitProfile: PermissionProfile | undefined,
  permissionMode: NonNullable<MakaToolContext['permissionMode']>,
  cwd: string,
): { profile: PermissionProfile; workspaceRoots: readonly string[] } {
  if (explicitProfile) return { profile: explicitProfile, workspaceRoots: [cwd] };
  const compiled = compilePermissionProfile({ mode: permissionMode, cwd });
  return { profile: compiled.profile, workspaceRoots: compiled.workspaceRoots };
}

function isPtyBashArgs(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as { pty?: unknown }).pty === true;
}

function terminalError(
  message: string,
  result: Pick<
    WorkspaceExecResult,
    'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated' | 'sandboxType' | 'sandboxed'
  >,
  code: number,
): Error {
  const error = new Error(message);
  const sandboxDenied = isLikelySandboxDenial(result);
  Object.assign(error, {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code,
    ...(result.sandboxType ? { sandboxType: result.sandboxType } : {}),
    sandboxed: result.sandboxed === true,
    ...(sandboxDenied ? { reason: 'sandbox_denial', recoverable: true } : {}),
  });
  return error;
}

function isLikelySandboxDenial(
  result: Pick<WorkspaceExecResult, 'stdout' | 'stderr' | 'sandboxed'>,
): boolean {
  if (result.sandboxed !== true) return false;
  const output = `${result.stderr}\n${result.stdout}`;
  return /operation not permitted|sandbox-exec|sandbox(?:ed)?[^\n]*den(?:y|ied)/i.test(output);
}

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}

export function classifyRuntimeResourceRef(path: string): 'runtime' | 'file' | 'unsupported' {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return path.trimStart().toLowerCase().startsWith('maka:') ? 'unsupported' : 'file';
  }
  if (url.protocol !== 'maka:') return 'file';
  if (
    url.hostname !== 'runtime'
    || url.username
    || url.password
    || url.port
    || !url.pathname
    || url.pathname === '/'
  ) {
    return 'unsupported';
  }
  return 'runtime';
}

// Object.fromEntries creates own data properties, so special keys like
// "__proto__" are preserved instead of triggering the inherited setter.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
