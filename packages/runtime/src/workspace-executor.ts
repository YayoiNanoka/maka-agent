import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { glob as nodeGlob } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ToolExecutionFacts } from '@maka/core/permission';
import type { PermissionProfile } from '@maka/core/permission-profile';
import {
  runProcessWithBoundedTail,
  runShellWithBoundedTail,
  type BoundedProcessOptions,
  type BoundedProcessResult,
} from './shell-exec.js';
import type {
  SandboxPathContext,
  SandboxPlatform,
  SandboxTransformFailureReason,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './sandbox/index.js';

const execAsync = promisify(exec);

export type WorkspaceIsolationKind = ToolExecutionFacts['isolation'];
export type WorkspaceWriteBackMode = ToolExecutionFacts['writeBack'];
export type WorkspaceNetworkMode = ToolExecutionFacts['network'];
export type WorkspaceSecretMode = ToolExecutionFacts['secrets'];
export type WorkspaceExecutorFacts = ToolExecutionFacts;

export const LOCAL_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

export interface WorkspaceExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadFileResult {
  content: string;
}

export interface WorkspaceWriteFileInput {
  cwd: string;
  path: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface WorkspaceResolvePathInput {
  cwd: string;
  path: string;
  label: string;
}

export interface WorkspaceResolvePathResult {
  path: string;
}

export interface WorkspaceWriteLockKeyInput {
  cwd: string;
  path: string;
}

export interface WorkspaceWriteLockKeyResult {
  key: string;
}

export interface WorkspaceGlobInput {
  cwd: string;
  pattern: string;
  limit?: number;
}

export interface WorkspaceGlobResult {
  files: string[];
}

export interface WorkspaceGrepInput {
  cwd: string;
  pattern: string;
  path: string;
  glob?: string;
  maxCountPerFile: number;
  limit: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface WorkspaceGrepResult {
  matches: string[];
}

export interface WorkspaceExecutorFactsProvider {
  readonly facts: WorkspaceExecutorFacts;
}

export interface WorkspaceCommandExecutor {
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
}

export interface WorkspaceReadFileExecutor {
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
}

export interface WorkspaceWriteFileExecutor {
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
}

export interface WorkspaceExistingPathResolver {
  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWritablePathResolver {
  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWriteLockProvider {
  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult>;
}

export interface WorkspaceGlobFilesExecutor {
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
}

export interface WorkspaceGrepFilesExecutor {
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
}

export type WorkspaceBashExecutor = WorkspaceExecutorFactsProvider & WorkspaceCommandExecutor;

export type WorkspaceReadExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceReadFileExecutor;

export type WorkspaceWriteExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceWritablePathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceWriteFileExecutor;

export type WorkspaceEditExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceReadFileExecutor
  & WorkspaceWriteFileExecutor;

export type WorkspaceGlobExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGlobFilesExecutor;

export type WorkspaceGrepExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGrepFilesExecutor;

export type WorkspaceSearchExecutor = WorkspaceGlobExecutor & WorkspaceGrepExecutor;

export interface WorkspaceExecutor
  extends WorkspaceBashExecutor,
    WorkspaceReadExecutor,
    WorkspaceWriteExecutor,
    WorkspaceEditExecutor,
    WorkspaceGlobExecutor,
    WorkspaceGrepExecutor {}

export interface WorkspaceCommandSandboxManager {
  transform(request: SandboxTransformRequest): SandboxTransformResult;
}

export interface WorkspaceCommandSandboxContext {
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  sandboxManager: WorkspaceCommandSandboxManager;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
}

export type WorkspaceCommandSandboxContextProvider =
  () => WorkspaceCommandSandboxContext | undefined;

export type WorkspaceCommandRunner = (
  argv: readonly string[],
  options: BoundedProcessOptions,
) => Promise<BoundedProcessResult>;

export type WorkspaceCommandSandboxErrorReason =
  | 'missing_context'
  | 'missing_workspace_roots'
  | SandboxTransformFailureReason;

export interface WorkspaceCommandSandboxErrorDetails {
  reason: WorkspaceCommandSandboxErrorReason;
  sandboxType?: SandboxType;
  requiresSandbox?: boolean;
  message?: string;
}

export class WorkspaceCommandSandboxError extends Error {
  readonly code = 'SANDBOX_COMMAND_BLOCKED';
  readonly reason: WorkspaceCommandSandboxErrorReason;
  readonly sandboxType?: SandboxType;
  readonly requiresSandbox?: boolean;

  constructor(details: WorkspaceCommandSandboxErrorDetails) {
    super(details.message ?? defaultSandboxErrorMessage(details.reason));
    this.name = 'WorkspaceCommandSandboxError';
    this.reason = details.reason;
    this.sandboxType = details.sandboxType;
    this.requiresSandbox = details.requiresSandbox;
  }
}

export interface SandboxedCommandWorkspaceExecutorOptions {
  inner: WorkspaceExecutor;
  getSandboxContext: WorkspaceCommandSandboxContextProvider;
  runProcess?: WorkspaceCommandRunner;
}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts = LOCAL_WORKSPACE_EXECUTOR_FACTS;

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const result = await runShellWithBoundedTail(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const content = await fs.readFile(input.path, 'utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    await fs.writeFile(input.path, input.content, 'utf8');
    return {
      ok: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    };
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveExistingInsideCwd(input.cwd, input.path, input.label) };
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveWritableInsideCwd(input.cwd, input.path, input.label) };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return { key: resolve(await fs.realpath(input.cwd), input.path) };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    const files: string[] = [];
    const limit = input.limit ?? 200;
    for await (const file of nodeGlob(input.pattern, { cwd: input.cwd })) {
      files.push(typeof file === 'string' ? file : (file as { name: string }).name);
      if (files.length >= limit) break;
    }
    return { files };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const args = ['-n', '--no-heading', `--max-count=${input.maxCountPerFile}`];
    if (input.glob) args.push('--glob', input.glob);
    args.push(input.pattern, input.path);
    const command = `rg ${args.map(shellEscape).join(' ')}`;
    try {
      const { stdout } = await execAsync(command, {
        cwd: input.cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeoutMs,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      return { matches: stdout.split('\n').filter(Boolean).slice(0, input.limit) };
    } catch (error: any) {
      if (error?.code === 1) return { matches: [] };
      throw error;
    }
  }
}

export class SandboxedCommandWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  private readonly inner: WorkspaceExecutor;
  private readonly getSandboxContext: WorkspaceCommandSandboxContextProvider;
  private readonly runProcess: WorkspaceCommandRunner;

  constructor(options: SandboxedCommandWorkspaceExecutorOptions) {
    this.inner = options.inner;
    this.facts = options.inner.facts;
    this.getSandboxContext = options.getSandboxContext;
    this.runProcess = options.runProcess ?? runProcessWithBoundedTail;
  }

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const context = this.getSandboxContext();
    if (!context) {
      throw new WorkspaceCommandSandboxError({
        reason: 'missing_context',
        message: 'Sandbox context is required for command execution but was unavailable.',
      });
    }
    if (!context.workspaceRoots || context.workspaceRoots.length === 0) {
      throw new WorkspaceCommandSandboxError({
        reason: 'missing_workspace_roots',
        message: 'Sandbox workspace roots are required for command execution but were unavailable.',
      });
    }

    const transform = context.sandboxManager.transform({
      command: {
        program: '/bin/sh',
        args: ['-lc', input.command],
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        profile: context.profile,
        pathContext: {
          tmpdir: osTmpdir(),
          slashTmp: '/tmp',
          ...context.pathContext,
          workspaceRoots: context.workspaceRoots,
        },
      },
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
    });

    if (!transform.ok) {
      throw new WorkspaceCommandSandboxError({
        reason: transform.reason,
        sandboxType: transform.sandboxType,
        requiresSandbox: transform.requiresSandbox,
        message: transform.message,
      });
    }

    const result = await this.runProcess(transform.exec.argv, {
      cwd: transform.exec.cwd,
      timeoutMs: input.timeoutMs,
      ...(transform.exec.env ? { env: transform.exec.env as NodeJS.ProcessEnv } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    return this.inner.readFile(input);
  }

  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    return this.inner.writeFile(input);
  }

  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return this.inner.resolveExistingPath(input);
  }

  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return this.inner.resolveWritablePath(input);
  }

  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return this.inner.writeLockKey(input);
  }

  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    return this.inner.globFiles(input);
  }

  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    return this.inner.grepFiles(input);
  }
}

export function createLocalWorkspaceExecutor(): WorkspaceExecutor {
  return new LocalWorkspaceExecutor();
}

function defaultSandboxErrorMessage(reason: WorkspaceCommandSandboxErrorReason): string {
  if (reason === 'missing_context') return 'Sandbox context is required for command execution but was unavailable.';
  if (reason === 'missing_workspace_roots') return 'Sandbox workspace roots are required for command execution but were unavailable.';
  return `Sandbox command transform failed: ${reason}.`;
}

function shellEscape(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function resolveWritableInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const parent = await fs.realpath(dirname(candidate));
  if (!isInside(root, parent)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return candidate;
}

async function resolveExistingInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const target = await fs.realpath(candidate);
  if (!isInside(root, target)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
