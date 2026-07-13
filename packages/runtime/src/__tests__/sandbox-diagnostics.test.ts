import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createDangerFullAccessPermissionProfile,
  createExternalPermissionProfile,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';

import {
  buildSandboxDiagnosticsSnapshot,
  toSandboxRunTraceProjection,
} from '../sandbox/diagnostics.js';
import type { ActiveSandboxCapabilities } from '../sandbox/active-capabilities.js';
import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';

describe('sandbox diagnostics snapshot', () => {
  test('summarizes workspace-write without copying capability messages', () => {
    const snapshot = buildSandboxDiagnosticsSnapshot({
      context: makeContext(createWorkspaceWritePermissionProfile()),
      capabilities: makeCapabilities('workspace-write', {
        filesystem: {
          status: 'unavailable',
          sandboxType: 'macos-seatbelt',
          reason: 'filesystem_worker_unavailable',
          message: '/secret/runtime/path should not escape',
        },
      }),
    });

    assert.deepEqual(snapshot, {
      schemaVersion: 1,
      profile: {
        name: 'workspace-write',
        type: 'managed',
        fileSystem: 'workspace-write',
        network: 'restricted',
        cwd: '/workspace/project',
        workspaceRoots: ['/workspace', '/workspace/extra'],
        protectedMetadata: ['.git', '.agents', '.codex'],
      },
      capabilities: {
        command: { status: 'available', backend: 'macos-seatbelt' },
        filesystem: {
          status: 'unavailable',
          backend: 'macos-seatbelt',
          reason: 'filesystem_worker_unavailable',
        },
      },
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /secret\/runtime/);
  });

  test('summarizes built-in profile families conservatively', () => {
    const cases: Array<[PermissionProfile, string, string, string]> = [
      [createReadOnlyPermissionProfile(), 'read-only', 'read-only', 'restricted'],
      [createDangerFullAccessPermissionProfile(), 'danger-full-access', 'unrestricted', 'enabled'],
      [createExternalPermissionProfile(), 'external', 'external', 'restricted'],
      [{ type: 'disabled', name: 'disabled' }, 'disabled', 'disabled', 'unmanaged'],
    ];

    for (const [profile, name, fileSystem, network] of cases) {
      const snapshot = buildSandboxDiagnosticsSnapshot({
        context: makeContext(profile),
        capabilities: profile.type === 'external'
          ? makeExternalCapabilities(name)
          : makeCapabilities(name, profile.type === 'managed' && profile.fileSystem.kind === 'unrestricted'
            ? {
                command: { status: 'not_required', sandboxType: 'none' },
                filesystem: { status: 'not_required', sandboxType: 'none' },
              }
            : {}),
      });
      assert.equal(snapshot.profile.fileSystem, fileSystem);
      assert.equal(snapshot.profile.network, network);
    }
  });

  test('uses custom-restricted for restricted writes that do not target workspace roots', () => {
    const profile: PermissionProfile = {
      type: 'managed',
      name: 'custom',
      fileSystem: {
        kind: 'restricted',
        entries: [{ kind: 'path', access: 'write', path: '/workspace/extra' }],
      },
      network: { kind: 'restricted' },
    };
    const snapshot = buildSandboxDiagnosticsSnapshot({
      context: makeContext(profile),
      capabilities: makeCapabilities('custom'),
    });
    assert.equal(snapshot.profile.fileSystem, 'custom-restricted');
  });

  test('deduplicates workspace roots and removes paths from RunTrace projection', () => {
    const context = makeContext(createReadOnlyPermissionProfile());
    const snapshot = buildSandboxDiagnosticsSnapshot({
      context: {
        ...context,
        workspaceRoots: ['/workspace', '/workspace', '/workspace/extra'],
      },
      capabilities: makeCapabilities('read-only'),
    });
    assert.deepEqual(snapshot.profile.workspaceRoots, ['/workspace', '/workspace/extra']);

    const projection = toSandboxRunTraceProjection(snapshot);
    assert.equal('cwd' in projection.profile, false);
    assert.equal('workspaceRoots' in projection.profile, false);
    assert.doesNotMatch(JSON.stringify(projection), /\/workspace/);
  });

  test('fails closed for mismatched profile and capability snapshots', () => {
    assert.throws(
      () => buildSandboxDiagnosticsSnapshot({
        context: makeContext(createReadOnlyPermissionProfile()),
        capabilities: makeCapabilities('workspace-write'),
      }),
      /profile mismatch/,
    );
  });

  test('fails closed for invalid paths and capability combinations', () => {
    const context = makeContext(createReadOnlyPermissionProfile());
    assert.throws(
      () => buildSandboxDiagnosticsSnapshot({
        context: { ...context, cwd: 'relative/path' },
        capabilities: makeCapabilities('read-only'),
      }),
      /canonical absolute path/,
    );
    assert.throws(
      () => buildSandboxDiagnosticsSnapshot({
        context,
        capabilities: makeCapabilities('read-only', {
          command: { status: 'available', sandboxType: 'none' },
        }),
      }),
      /cannot be available with backend none/,
    );
    assert.throws(
      () => buildSandboxDiagnosticsSnapshot({
        context,
        capabilities: makeCapabilities('read-only', {
          filesystem: { status: 'unavailable', sandboxType: 'none' },
        }),
      }),
      /requires a reason/,
    );
  });
});

function makeContext(profile: PermissionProfile): PermissionAwareSandboxContext {
  return {
    cwd: '/workspace/project',
    profile,
    workspaceRoots: ['/workspace', '/workspace/extra'],
    sandboxManager: { transform: () => { throw new Error('unused'); } },
    platform: 'darwin',
    pathContext: {
      workspaceRoots: ['/workspace', '/workspace/extra'],
      tmpdir: '/private/tmp',
      slashTmp: '/tmp',
    },
  };
}

function makeCapabilities(
  profileName: string,
  overrides: Partial<Pick<ActiveSandboxCapabilities, 'command' | 'filesystem'>> = {},
): ActiveSandboxCapabilities {
  return {
    profileName,
    platform: 'darwin',
    command: overrides.command ?? { status: 'available', sandboxType: 'macos-seatbelt' },
    filesystem: overrides.filesystem ?? { status: 'available', sandboxType: 'macos-seatbelt' },
  };
}

function makeExternalCapabilities(profileName: string): ActiveSandboxCapabilities {
  return {
    profileName,
    platform: 'linux',
    command: { status: 'external', sandboxType: 'none' },
    filesystem: { status: 'external', sandboxType: 'none' },
  };
}
