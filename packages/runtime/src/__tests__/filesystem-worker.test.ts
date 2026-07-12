import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  executeFilesystemWorkerRequest,
  type FilesystemWorkerGrepRunInput,
} from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerRequestSchema,
  FilesystemWorkerResponseSchema,
  parseFilesystemWorkerResponse,
  type FilesystemWorkerOperation,
} from '../filesystem-worker/protocol.js';

describe('filesystem worker protocol', () => {
  test('rejects unknown fields and unsupported protocol versions', () => {
    assert.equal(FilesystemWorkerRequestSchema.safeParse({
      version: 2,
      requestId: 'request-1',
      operation: { kind: 'read', cwd: '/workspace', path: 'file.txt' },
    }).success, false);
    assert.equal(FilesystemWorkerRequestSchema.safeParse({
      version: 1,
      requestId: 'request-1',
      operation: { kind: 'read', cwd: '/workspace', path: 'file.txt', executable: '/bin/sh' },
    }).success, false);
  });

  test('validates success and failure responses in both directions', () => {
    assert.equal(FilesystemWorkerResponseSchema.safeParse({
      version: 1,
      requestId: 'request-1',
      ok: true,
      result: { kind: 'read', content: 'ok' },
    }).success, true);
    assert.equal(FilesystemWorkerResponseSchema.safeParse({
      version: 1,
      requestId: 'request-1',
      ok: false,
      error: { code: 'filesystem_error', message: 'failed', stack: 'sensitive' },
    }).success, false);
  });
});

describe('filesystem worker operations', () => {
  test('reads bounded lines and writes files inside cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    await writeFile(join(cwd, 'input.txt'), 'one\ntwo\nthree', 'utf8');

    const readResponse = await execute(cwd, {
      kind: 'read',
      cwd,
      path: 'input.txt',
      offset: 1,
      limit: 1,
    });
    assert.deepEqual(readResponse, {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId: 'request-1',
      ok: true,
      result: { kind: 'read', content: 'two' },
    });

    const writeResponse = await execute(cwd, {
      kind: 'write',
      cwd,
      path: 'output.txt',
      content: 'written',
    });
    assert.equal(writeResponse.ok, true);
    assert.equal(await readFile(join(cwd, 'output.txt'), 'utf8'), 'written');
  });

  test('resolves, matches, and writes Edit in one operation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    await writeFile(join(cwd, 'edit.txt'), 'before\ntarget\nafter\n', 'utf8');

    const response = await execute(cwd, {
      kind: 'edit',
      cwd,
      path: 'edit.txt',
      oldString: 'target',
      newString: 'changed',
    });

    assert.equal(response.ok, true);
    if (response.ok) {
      const canonicalCwd = await realpath(cwd);
      assert.deepEqual(response.result, {
        kind: 'edit',
        ok: true,
        path: join(canonicalCwd, 'edit.txt'),
        replacements: 1,
        matchedVia: 'exact',
        startLine: 2,
        endLine: 2,
      });
    }
    assert.equal(await readFile(join(cwd, 'edit.txt'), 'utf8'), 'before\nchanged\nafter\n');
  });

  test('returns an edit_conflict without a stack or request content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    await writeFile(join(cwd, 'edit.txt'), 'same same', 'utf8');

    const response = await execute(cwd, {
      kind: 'edit',
      cwd,
      path: 'edit.txt',
      oldString: 'same',
      newString: 'secret-replacement',
    });

    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'edit_conflict');
    assert.equal(JSON.stringify(response).includes('secret-replacement'), false);
    assert.doesNotThrow(() => parseFilesystemWorkerResponse(response));
  });

  test('globs below a resolved search root and enforces the result cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'a.ts'), 'a', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), 'b', 'utf8');

    const response = await execute(cwd, {
      kind: 'glob',
      cwd,
      path: 'src',
      pattern: '*.ts',
      limit: 1,
    });

    assert.equal(response.ok, true);
    if (response.ok) assert.equal(response.result.kind === 'glob' && response.result.files.length, 1);
  });

  test('runs Grep through an injected executable argv runner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    await mkdir(join(cwd, 'src'));
    const calls: FilesystemWorkerGrepRunInput[] = [];

    const response = await executeFilesystemWorkerRequest({
      version: 1,
      requestId: 'request-1',
      operation: {
        kind: 'grep',
        cwd,
        path: 'src',
        pattern: 'token',
        glob: '*.ts',
        maxCountPerFile: 50,
        limit: 1,
        timeoutMs: 5_000,
      },
    }, {
      grepExecutable: '/runtime/rg',
      runGrep: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: 'a.ts:1:token\nb.ts:1:token\n' };
      },
    });

    assert.equal(response.ok, true);
    if (response.ok) assert.deepEqual(response.result, { kind: 'grep', matches: ['a.ts:1:token'] });
    const canonicalCwd = await realpath(cwd);
    assert.deepEqual(calls, [{
      executable: '/runtime/rg',
      args: ['-n', '--no-heading', '--max-count=50', '--glob', '*.ts', 'token', join(canonicalCwd, 'src')],
      cwd: canonicalCwd,
      timeoutMs: 5_000,
    }]);
  });

  test('blocks parent traversal, absolute paths, and symlink escapes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-fs-worker-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'escape.txt'));

    for (const operation of [
      { kind: 'read', cwd, path: '../outside.txt' },
      { kind: 'read', cwd, path: join(outside, 'secret.txt') },
      { kind: 'read', cwd, path: 'escape.txt' },
      { kind: 'write', cwd, path: 'escape.txt', content: 'overwrite' },
      { kind: 'glob', cwd, path: '.', pattern: '../*' },
    ] satisfies FilesystemWorkerOperation[]) {
      const response = await execute(cwd, operation);
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.error.code, 'path_denied');
    }
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
  });

  test('returns not_found and grep_unavailable as structured errors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-'));
    const missing = await execute(cwd, { kind: 'read', cwd, path: 'missing.txt' });
    const grep = await execute(cwd, {
      kind: 'grep',
      cwd,
      path: '.',
      pattern: 'token',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });

    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'not_found');
    assert.equal(grep.ok, false);
    if (!grep.ok) assert.equal(grep.error.code, 'grep_unavailable');
  });
});

async function execute(_cwd: string, operation: FilesystemWorkerOperation) {
  return await executeFilesystemWorkerRequest({
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'request-1',
    operation,
  });
}
