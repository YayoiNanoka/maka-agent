import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { expect } from '../test-helpers.js';
import {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  LocalWorkspaceExecutor,
  SandboxedCommandWorkspaceExecutor,
  WorkspaceCommandSandboxError,
  type WorkspaceExecInput,
  type WorkspaceCommandSandboxContext,
  type WorkspaceExecutor,
} from '../workspace-executor.js';
import type { BoundedProcessOptions } from '../shell-exec.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/index.js';

describe('LocalWorkspaceExecutor exec', () => {
  test('runs commands in the provided cwd and streams stdout/stderr', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    await writeFile(join(cwd, 'marker.txt'), 'from-cwd', 'utf8');
    const executor = new LocalWorkspaceExecutor();
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];

    const result = await executor.exec({
      command: 'printf "$(cat marker.txt)"; printf "err-data" >&2',
      cwd,
      timeoutMs: 5_000,
      emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => events.push({ stream, chunk }),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'from-cwd',
      stderr: 'err-data',
    });
    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('from-cwd'))).toBe(true);
    expect(events.some((event) => event.stream === 'stderr' && event.chunk.includes('err-data'))).toBe(true);
  });

  test('reports non-zero exit without throwing so tools can preserve their own error contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "out-data"; printf "err-data" >&2; exit 7',
      cwd,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: 'out-data',
      stderr: 'err-data',
    });
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test('reports timeout with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "before-timeout"; sleep 5',
      cwd,
      timeoutMs: 200,
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('before-timeout');
  });

  test('reports abort with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();
    const controller = new AbortController();

    const resultPromise = executor.exec({
      command: 'printf "before-abort"; sleep 5; printf "after-abort"',
      cwd,
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('before-abort');
  });
});

describe('LocalWorkspaceExecutor file operations', () => {
  test('reads and writes text files by absolute path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');

    const writeResult = await executor.writeFile({ cwd, path: file, content: 'hello' });
    const readResult = await executor.readFile({ cwd, path: file });

    expect(writeResult).toMatchObject({
      ok: true,
      path: file,
      bytes: 5,
    });
    expect(readResult).toMatchObject({ content: 'hello' });
    expect(await readFile(file, 'utf8')).toBe('hello');
  });

  test('applies read offset and limit at the executor boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');
    await writeFile(file, 'line1\nline2\nline3\nline4', 'utf8');

    const readResult = await executor.readFile({ cwd, path: file, offset: 1, limit: 2 });

    expect(readResult).toMatchObject({ content: 'line2\nline3' });
  });

  test('globs files from the provided cwd with a result cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-glob-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.ts'), 'a', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), 'b', 'utf8');
    await writeFile(join(cwd, 'src', 'c.js'), 'c', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.globFiles({ cwd, pattern: 'src/*.*', limit: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.startsWith('src/'))).toBe(true);
  });

  test('greps file contents with rg-compatible no-match behavior', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-grep-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.ts'), 'export const token = 1;\n', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const hit = await executor.grepFiles({
      cwd,
      pattern: 'token',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });
    const miss = await executor.grepFiles({
      cwd,
      pattern: 'absent',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });

    expect(hit.matches.some((match) => match.includes('main.ts'))).toBe(true);
    expect(miss).toMatchObject({ matches: [] });
  });
});

describe('SandboxedCommandWorkspaceExecutor exec', () => {
  test('transforms /bin/sh -lc command and executes the final sandbox argv', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-sandboxed-command-'));
    const transformCalls: SandboxTransformRequest[] = [];
    const runCalls: Array<{ argv: readonly string[]; options: unknown }> = [];
    const abort = new AbortController();
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const sandboxManager = {
      transform(request: SandboxTransformRequest): SandboxTransformResult {
        transformCalls.push(request);
        return {
          ok: true,
          exec: {
            argv: ['/usr/bin/sandbox-exec', '-p', 'policy', '--', request.command.program, ...request.command.args],
            cwd: request.command.cwd,
            env: request.command.env,
            sandboxType: 'macos-seatbelt',
            effectiveProfile: request.command.profile,
          },
          sandboxType: 'macos-seatbelt',
          requiresSandbox: true,
          preference: 'auto',
        };
      },
    };
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor(),
      getSandboxContext: () => ({
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [cwd],
        sandboxManager,
        platform: 'darwin',
        preference: 'auto',
        pathContext: { minimalRoots: ['/usr', '/bin'] },
      }),
      runProcess: async (argv: readonly string[], options: BoundedProcessOptions) => {
        runCalls.push({ argv, options });
        options.emitOutput?.('stdout', 'live-out');
        return {
          exitCode: 0,
          stdout: 'sandbox-out',
          stderr: 'sandbox-err',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          aborted: false,
        };
      },
    });

    const result = await executor.exec({
      command: 'echo "$PHASE6"',
      cwd,
      env: { PHASE6: 'ok' },
      timeoutMs: 12_345,
      abortSignal: abort.signal,
      emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => events.push({ stream, chunk }),
    });

    expect(transformCalls).toHaveLength(1);
    expect(transformCalls[0]?.command.program).toBe('/bin/sh');
    expect(transformCalls[0]?.command.args).toEqual(['-lc', 'echo "$PHASE6"']);
    expect(transformCalls[0]?.command.cwd).toBe(cwd);
    expect(transformCalls[0]?.command.env).toEqual({ PHASE6: 'ok' });
    expect(transformCalls[0]?.command.pathContext).toMatchObject({
      workspaceRoots: [cwd],
      slashTmp: '/tmp',
      minimalRoots: ['/usr', '/bin'],
    });
    expect(transformCalls[0]?.preference).toBe('auto');
    expect(transformCalls[0]?.platform).toBe('darwin');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.argv).toEqual([
      '/usr/bin/sandbox-exec',
      '-p',
      'policy',
      '--',
      '/bin/sh',
      '-lc',
      'echo "$PHASE6"',
    ]);
    expect(runCalls[0]?.options).toMatchObject({
      cwd,
      env: { PHASE6: 'ok' },
      timeoutMs: 12_345,
      abortSignal: abort.signal,
    });
    expect(events).toEqual([{ stream: 'stdout', chunk: 'live-out' }]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'sandbox-out',
      stderr: 'sandbox-err',
      timedOut: false,
      aborted: false,
    });
  });

  test('fails closed when sandbox context is missing', async () => {
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor(),
      getSandboxContext: () => undefined,
    });

    const err = await captureError(() => executor.exec({
      command: 'echo no-context',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect(err instanceof WorkspaceCommandSandboxError).toBe(true);
    expect((err as WorkspaceCommandSandboxError).code).toBe('SANDBOX_COMMAND_BLOCKED');
    expect((err as WorkspaceCommandSandboxError).reason).toBe('missing_context');
  });

  test('fails closed when workspaceRoots are missing or empty', async () => {
    const missing = await captureError(() => executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      sandboxManager: passthroughSandboxManager(),
    } as WorkspaceCommandSandboxContext).exec({
      command: 'echo missing-roots',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));
    const empty = await captureError(() => executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [],
      sandboxManager: passthroughSandboxManager(),
    }).exec({
      command: 'echo empty-roots',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect((missing as WorkspaceCommandSandboxError).reason).toBe('missing_workspace_roots');
    expect((empty as WorkspaceCommandSandboxError).reason).toBe('missing_workspace_roots');
  });

  test('throws structured error when sandbox transform fails', async () => {
    const executor = executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: ['/workspace'],
      sandboxManager: {
        transform(): SandboxTransformResult {
          return {
            ok: false,
            reason: 'backend_not_available',
            sandboxType: 'macos-seatbelt',
            requiresSandbox: true,
            platform: 'darwin',
            preference: 'auto',
            message: 'macOS Seatbelt backend is not registered.',
          };
        },
      },
      platform: 'darwin',
    });

    const err = await captureError(() => executor.exec({
      command: 'echo blocked',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect(err instanceof WorkspaceCommandSandboxError).toBe(true);
    expect((err as WorkspaceCommandSandboxError).code).toBe('SANDBOX_COMMAND_BLOCKED');
    expect((err as WorkspaceCommandSandboxError).reason).toBe('backend_not_available');
    expect((err as WorkspaceCommandSandboxError).sandboxType).toBe('macos-seatbelt');
    expect((err as WorkspaceCommandSandboxError).requiresSandbox).toBe(true);
    expect(err.message).toContain('macOS Seatbelt backend is not registered.');
  });

  test('delegates non-command workspace operations to the inner executor', async () => {
    const calls: string[] = [];
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor({
        readFile: async () => {
          calls.push('readFile');
          return { content: 'read' };
        },
        writeFile: async () => {
          calls.push('writeFile');
          return { ok: true, path: '/workspace/out.txt', bytes: 3 };
        },
        resolveExistingPath: async () => {
          calls.push('resolveExistingPath');
          return { path: '/workspace/existing.txt' };
        },
        resolveWritablePath: async () => {
          calls.push('resolveWritablePath');
          return { path: '/workspace/new.txt' };
        },
        writeLockKey: async () => {
          calls.push('writeLockKey');
          return { key: 'lock' };
        },
        globFiles: async () => {
          calls.push('globFiles');
          return { files: ['a.ts'] };
        },
        grepFiles: async () => {
          calls.push('grepFiles');
          return { matches: ['a.ts:1:x'] };
        },
      }),
      getSandboxContext: () => {
        throw new Error('non-command methods must not request sandbox context');
      },
    });

    expect(await executor.readFile({ cwd: '/workspace', path: '/workspace/a.txt' })).toEqual({ content: 'read' });
    expect(await executor.writeFile({ cwd: '/workspace', path: '/workspace/out.txt', content: 'out' })).toMatchObject({ ok: true });
    expect(await executor.resolveExistingPath({ cwd: '/workspace', path: 'existing.txt', label: 'Read' })).toEqual({ path: '/workspace/existing.txt' });
    expect(await executor.resolveWritablePath({ cwd: '/workspace', path: 'new.txt', label: 'Write' })).toEqual({ path: '/workspace/new.txt' });
    expect(await executor.writeLockKey({ cwd: '/workspace', path: 'out.txt' })).toEqual({ key: 'lock' });
    expect(await executor.globFiles({ cwd: '/workspace', pattern: '*.ts', limit: 200 })).toEqual({ files: ['a.ts'] });
    expect(await executor.grepFiles({
      cwd: '/workspace',
      pattern: 'x',
      path: '/workspace',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 1_000,
    })).toEqual({ matches: ['a.ts:1:x'] });
    expect(calls).toEqual([
      'readFile',
      'writeFile',
      'resolveExistingPath',
      'resolveWritablePath',
      'writeLockKey',
      'globFiles',
      'grepFiles',
    ]);
  });
});

function executorWithContext(context: WorkspaceCommandSandboxContext): SandboxedCommandWorkspaceExecutor {
  return new SandboxedCommandWorkspaceExecutor({
    inner: fakeExecutor(),
    getSandboxContext: () => context,
    runProcess: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    }),
  });
}

function passthroughSandboxManager() {
  return {
    transform(request: SandboxTransformRequest): SandboxTransformResult {
      return {
        ok: true,
        exec: {
          argv: [request.command.program, ...request.command.args],
          cwd: request.command.cwd,
          env: request.command.env,
          sandboxType: 'none',
          effectiveProfile: request.command.profile,
        },
        sandboxType: 'none',
        requiresSandbox: false,
        preference: 'auto',
      };
    },
  };
}

function fakeExecutor(overrides: Partial<WorkspaceExecutor> = {}): WorkspaceExecutor {
  const base: WorkspaceExecutor = {
    facts: LOCAL_WORKSPACE_EXECUTOR_FACTS,
    exec: async (_input: WorkspaceExecInput) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
    }),
    readFile: async () => ({ content: '' }),
    writeFile: async ({ path, content }) => ({ ok: true, path, bytes: Buffer.byteLength(content, 'utf8') }),
    resolveExistingPath: async ({ path }) => ({ path }),
    resolveWritablePath: async ({ path }) => ({ path }),
    writeLockKey: async ({ cwd, path }) => ({ key: `${cwd}:${path}` }),
    globFiles: async () => ({ files: [] }),
    grepFiles: async () => ({ matches: [] }),
  };
  return Object.assign(base, overrides);
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(String(error));
  }
  throw new Error('expected function to reject');
}
