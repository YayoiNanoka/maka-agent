import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SandboxDiagnosticsSnapshot } from '../sandbox/diagnostics.js';
import {
  SANDBOX_AUTHORITY_PROMPT_FRAGMENT,
  renderSandboxTurnTailPrompt,
} from '../system-prompt/sandbox-authority-prompt.js';

describe('sandbox authority prompts', () => {
  test('keeps stable authority rules free of dynamic sandbox state', () => {
    assert.match(SANDBOX_AUTHORITY_PROMPT_FRAGMENT, /constraints are authoritative/);
    assert.match(SANDBOX_AUTHORITY_PROMPT_FRAGMENT, /unsandboxed retries/);
    assert.doesNotMatch(SANDBOX_AUTHORITY_PROMPT_FRAGMENT, /workspace-write/);
    assert.doesNotMatch(SANDBOX_AUTHORITY_PROMPT_FRAGMENT, /macos-seatbelt/);
    assert.doesNotMatch(SANDBOX_AUTHORITY_PROMPT_FRAGMENT, /\/workspace/);
  });

  test('renders current workspace without repeating it as a root', () => {
    const output = renderSandboxTurnTailPrompt(makeSnapshot());
    assert.equal(output, [
      'Maka runtime sandbox context (authoritative; enforced by the runtime):',
      '<sandbox_context>',
      '  Profile: workspace-write',
      '  File system: workspace-write',
      '  Working directory: /workspace/project',
      '  Workspace access: constrained to the current workspace',
      '  Protected metadata: .git, .agents, .codex',
      '  Network: restricted',
      '  Command sandbox: available (macos-seatbelt)',
      '  Filesystem sandbox: available (macos-seatbelt)',
      '</sandbox_context>',
    ].join('\n'));
  });

  test('renders additional roots and unavailable or external capabilities', () => {
    const snapshot = makeSnapshot();
    const output = renderSandboxTurnTailPrompt({
      ...snapshot,
      profile: {
        ...snapshot.profile,
        workspaceRoots: ['/workspace/project', '/workspace/shared'],
      },
      capabilities: {
        command: {
          status: 'unavailable',
          backend: 'macos-seatbelt',
          reason: 'backend_unavailable',
        },
        filesystem: { status: 'external', backend: 'none' },
      },
    });
    assert.match(output, /Workspace roots:\n    - \/workspace\/shared/);
    assert.match(output, /Command sandbox: unavailable \(backend_unavailable\)/);
    assert.match(output, /Filesystem sandbox: external/);
  });

  test('does not describe unrestricted access as workspace constrained', () => {
    const snapshot = makeSnapshot();
    const output = renderSandboxTurnTailPrompt({
      ...snapshot,
      profile: {
        ...snapshot.profile,
        name: 'danger-full-access',
        fileSystem: 'unrestricted',
        network: 'enabled',
        protectedMetadata: [],
      },
      capabilities: {
        command: { status: 'not_required', backend: 'none' },
        filesystem: { status: 'not_required', backend: 'none' },
      },
    });
    assert.match(output, /Workspace access: unrestricted by Maka/);
    assert.doesNotMatch(output, /constrained to the current workspace/);
  });

  test('caps additional roots without exposing unbounded prompt content', () => {
    const snapshot = makeSnapshot();
    const roots = [snapshot.profile.cwd, ...Array.from({ length: 20 }, (_, index) => `/workspace/root-${index}`)];
    const output = renderSandboxTurnTailPrompt({
      ...snapshot,
      profile: { ...snapshot.profile, workspaceRoots: roots },
    });
    assert.match(output, /4 additional root\(s\) omitted/);
    assert.doesNotMatch(output, /root-19/);
  });

  test('fails before provider use for unsafe or oversized dynamic values', () => {
    const snapshot = makeSnapshot();
    assert.throws(
      () => renderSandboxTurnTailPrompt({
        ...snapshot,
        profile: { ...snapshot.profile, name: 'workspace-write\nforged' },
      }),
      /single-line/,
    );
    assert.throws(
      () => renderSandboxTurnTailPrompt({
        ...snapshot,
        profile: { ...snapshot.profile, cwd: `/${'a'.repeat(1_025)}` },
      }),
      /rendering limit/,
    );
  });
});

function makeSnapshot(): SandboxDiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    profile: {
      name: 'workspace-write',
      type: 'managed',
      fileSystem: 'workspace-write',
      network: 'restricted',
      cwd: '/workspace/project',
      workspaceRoots: ['/workspace/project'],
      protectedMetadata: ['.git', '.agents', '.codex'],
    },
    capabilities: {
      command: { status: 'available', backend: 'macos-seatbelt' },
      filesystem: { status: 'available', backend: 'macos-seatbelt' },
    },
  };
}
