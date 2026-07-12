import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { glob as nodeGlob } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { computeEditedSource } from '../edit-replace.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerOperation,
  type FilesystemWorkerRequest,
  type FilesystemWorkerResponse,
  type FilesystemWorkerResult,
} from './protocol.js';

const DEFAULT_GLOB_LIMIT = 200;
const MAX_GREP_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface FilesystemWorkerOperationDependencies {
  grepExecutable?: string;
  runGrep?: FilesystemWorkerGrepRunner;
}

export interface FilesystemWorkerGrepRunInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

export interface FilesystemWorkerGrepRunResult {
  exitCode: number;
  stdout: string;
}

export type FilesystemWorkerGrepRunner = (
  input: FilesystemWorkerGrepRunInput,
) => Promise<FilesystemWorkerGrepRunResult>;

export async function executeFilesystemWorkerRequest(
  request: FilesystemWorkerRequest,
  dependencies: FilesystemWorkerOperationDependencies = {},
): Promise<FilesystemWorkerResponse> {
  try {
    return {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: await executeFilesystemOperation(request.operation, dependencies),
    };
  } catch (error) {
    const normalized = normalizeOperationError(error);
    return {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
  }
}

export async function executeFilesystemOperation(
  operation: FilesystemWorkerOperation,
  dependencies: FilesystemWorkerOperationDependencies = {},
): Promise<FilesystemWorkerResult> {
  switch (operation.kind) {
    case 'read': {
      const path = await resolveExistingInsideCwd(operation.cwd, operation.path, 'Read');
      const content = await fs.readFile(path, 'utf8');
      if (operation.offset === undefined && operation.limit === undefined) {
        return { kind: 'read', content };
      }
      const lines = content.split('\n');
      const start = operation.offset ?? 0;
      const end = operation.limit ? start + operation.limit : lines.length;
      return { kind: 'read', content: lines.slice(start, end).join('\n') };
    }
    case 'write': {
      const path = await resolveWritableInsideCwd(operation.cwd, operation.path, 'Write');
      await fs.writeFile(path, operation.content, 'utf8');
      return {
        kind: 'write',
        ok: true,
        path,
        bytes: Buffer.byteLength(operation.content, 'utf8'),
      };
    }
    case 'edit': {
      const path = await resolveExistingInsideCwd(operation.cwd, operation.path, 'Edit');
      const content = await fs.readFile(path, 'utf8');
      let edited: ReturnType<typeof computeEditedSource>;
      try {
        edited = computeEditedSource(content, operation.oldString, operation.newString, operation.path);
      } catch (error) {
        throw new FilesystemOperationError(
          'edit_conflict',
          error instanceof Error ? error.message : 'Edit could not be applied.',
        );
      }
      await fs.writeFile(path, edited.content, 'utf8');
      return {
        kind: 'edit',
        ok: true,
        path,
        replacements: 1,
        matchedVia: edited.matchedVia,
        startLine: edited.startLine,
        endLine: edited.endLine,
      };
    }
    case 'glob': {
      assertContainedGlobPattern(operation.pattern);
      const path = await resolveExistingInsideCwd(operation.cwd, operation.path, 'Glob cwd');
      const files: string[] = [];
      const limit = operation.limit ?? DEFAULT_GLOB_LIMIT;
      for await (const file of nodeGlob(operation.pattern, { cwd: path })) {
        files.push(typeof file === 'string' ? file : (file as { name: string }).name);
        if (files.length >= limit) break;
      }
      return { kind: 'glob', files };
    }
    case 'grep': {
      const path = await resolveExistingInsideCwd(operation.cwd, operation.path, 'Grep');
      const executable = dependencies.grepExecutable;
      if (!executable) {
        throw new FilesystemOperationError('grep_unavailable', 'Grep is unavailable in this runtime.');
      }
      const args = ['-n', '--no-heading', `--max-count=${operation.maxCountPerFile}`];
      if (operation.glob) args.push('--glob', operation.glob);
      args.push(operation.pattern, path);
      const result = await (dependencies.runGrep ?? runRipgrep)({
        executable,
        args,
        cwd: await fs.realpath(operation.cwd),
        timeoutMs: operation.timeoutMs,
      });
      if (result.exitCode === 1) return { kind: 'grep', matches: [] };
      if (result.exitCode !== 0) {
        throw new FilesystemOperationError('filesystem_error', 'Grep failed while searching files.');
      }
      return {
        kind: 'grep',
        matches: result.stdout.split('\n').filter(Boolean).slice(0, operation.limit),
      };
    }
  }
}

class FilesystemOperationError extends Error {
  constructor(readonly code: FilesystemWorkerErrorCode, message: string) {
    super(message);
    this.name = 'FilesystemOperationError';
  }
}

function normalizeOperationError(error: unknown): FilesystemOperationError {
  if (error instanceof FilesystemOperationError) return error;
  const code = nodeErrorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FilesystemOperationError('not_found', 'The requested workspace path was not found.');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FilesystemOperationError('filesystem_denied', 'Filesystem access was denied.');
  }
  return new FilesystemOperationError('filesystem_error', 'Filesystem operation failed.');
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function resolveWritableInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  const { root, candidate } = await resolveCandidate(cwd, inputPath, label);
  try {
    const target = await fs.realpath(candidate);
    assertInside(root, target, label);
    return target;
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const parent = await fs.realpath(dirname(candidate));
  assertInside(root, parent, label);
  return candidate;
}

async function resolveExistingInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  const { root, candidate } = await resolveCandidate(cwd, inputPath, label);
  const target = await fs.realpath(candidate);
  assertInside(root, target, label);
  return target;
}

async function resolveCandidate(
  cwd: string,
  inputPath: string,
  label: string,
): Promise<{ root: string; candidate: string }> {
  if (isAbsolute(inputPath)) {
    throw new FilesystemOperationError('path_denied', `${label} path must be relative to session cwd.`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  assertInside(root, candidate, label);
  return { root, candidate };
}

function assertInside(root: string, target: string, label: string): void {
  const rel = relative(root, target);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new FilesystemOperationError('path_denied', `${label} path must stay inside session cwd.`);
  }
}

function assertContainedGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new FilesystemOperationError('path_denied', 'Glob pattern must stay inside its search root.');
  }
}

async function runRipgrep(
  input: FilesystemWorkerGrepRunInput,
): Promise<FilesystemWorkerGrepRunResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectOnce(new FilesystemOperationError('filesystem_error', 'Grep timed out.'));
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GREP_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        rejectOnce(new FilesystemOperationError('filesystem_error', 'Grep output exceeded the worker limit.'));
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      if (nodeErrorCode(error) === 'ENOENT') {
        rejectOnce(new FilesystemOperationError('grep_unavailable', 'Grep is unavailable in this runtime.'));
        return;
      }
      rejectOnce(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 2,
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    });

    function rejectOnce(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}
