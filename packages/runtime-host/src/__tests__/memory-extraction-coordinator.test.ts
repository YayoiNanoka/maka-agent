import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionHeader } from '@maka/core/session';
import {
  openInteractiveLongTermMemoryStoreForWrite,
  type InteractiveLongTermMemoryWriter,
} from '@maka/storage/long-term-memory-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimePolicyReader } from '@maka/storage/runtime-policy-stores';
import type { MemoryExtractionSourceSnapshot } from '@maka/runtime';

import { HostMemoryExtractionCoordinator } from '../server/memory-extraction-coordinator.js';
import { MemoryExtractionSessionLane } from '../server/memory-extraction-session-lane.js';

describe('HostMemoryExtractionCoordinator', () => {
  test('crosses Runs with a Session Cursor, preserves provider configuration, appends changes, and replays exactly', async () => {
    await withMemoryWriter(async (writer) => {
      const entries: Array<{ ordinal: number; event: RuntimeEvent }> = [];
      const outputs = [
        proposal('The user prefers concise Chinese.', 'global', 'event-user-1'),
        proposal('The user prefers detailed English.', 'workspace', 'event-user-2'),
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({ writer, entries, outputs, observed });

      entries.push(
        {
          ordinal: 1,
          event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer concise Chinese.'),
        },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      );
      const firstSnapshot = snapshot(
        'run-1',
        'turn-1',
        'call-1',
        'Prefer concise Chinese.',
        'event-user-1',
      );
      const first = await coordinator.sourceCapabilities().remember(firstSnapshot);
      assert.equal(first.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 1);

      entries.push(
        {
          ordinal: 3,
          event: textEvent('event-user-2', 'run-2', 'turn-2', 'Prefer detailed English.'),
        },
        { ordinal: 4, event: toolCallEvent('event-call-2', 'run-2', 'turn-2', 'call-2') },
      );
      const second = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-2', 'turn-2', 'call-2', 'Prefer detailed English.'));
      assert.equal(second.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);

      const stored = await writer.searchByKeys({
        terms: ['response preference'],
        match: 'exact',
        workspaceKey: '/workspace/maka',
      });
      assert.equal(stored.length, 2);
      assert.deepEqual(
        stored.map(({ item }) => [item.content, item.scopeType, item.scopeKey]),
        [
          ['The user prefers detailed English.', 'workspace', '/workspace/maka'],
          ['The user prefers concise Chinese.', 'global', null],
        ],
      );

      const replay = await coordinator.sourceCapabilities().remember(firstSnapshot);
      assert.deepEqual(replay, first);
      assert.equal(observed.length, 2, 'receipt replay must not call the provider');
      assert.deepEqual(Object.keys(observed[0]!.snapshot.sourceTools), ['memory_remember']);
      assert.deepEqual(observed[0]!.snapshot.sourceActiveTools, ['memory_remember']);
      assert.doesNotMatch(observed[0]!.prompt, /Prefer concise Chinese\./);
      assert.match(observed[0]!.prompt, /"messagePositions":\[0\]/);
      await coordinator.close();
    });
  });

  test('rechecks Incognito after the provider call and commits nothing', async () => {
    await withMemoryWriter(async (writer) => {
      const policyState = { incognito: false };
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [proposal('The user prefers Rust.', 'global', 'event-user-1')],
        policyState,
        afterModelCall: () => {
          policyState.incognito = true;
        },
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));
      assert.equal(result.status, 'unavailable');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      await coordinator.close();
    });
  });

  test('drops invalid Items individually while committing valid requested Items and the Cursor', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        {
          ordinal: 2,
          event: modelTextEvent(
            'event-assistant-1',
            'run-1',
            'turn-1',
            'The volatile Tool result says the account balance is 42.',
          ),
        },
        { ordinal: 3, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const valid = proposalItem('The user prefers Rust.', 'global', 'event-user-1');
      const invalid = {
        ...proposalItem('Invalid incidental memory.', 'global', 'missing-event', 'missing'),
        kind: 'note',
      };
      const unconfirmedAssistant = {
        ...proposalItem(
          'The account balance is 42.',
          'workspace',
          'event-assistant-1',
          'account balance is 42',
        ),
        kind: 'knowledge',
      };
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'resolved',
            requestedItems: [valid],
            incidentalItems: [invalid, unconfirmedAssistant],
          }),
        ],
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));

      assert.equal(result.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      const stored = await writer.searchByKeys({ terms: ['response preference'], match: 'exact' });
      assert.deepEqual(
        stored.map(({ item }) => item.content),
        ['The user prefers Rust.'],
      );
      await coordinator.close();
    });
  });

  test('treats a second memory_remember at an already processed boundary as a no-op', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [proposal('The user prefers Rust.', 'global', 'event-user-1')],
        observed,
      });

      await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));
      entries.push({
        ordinal: 3,
        event: toolCallEvent('event-call-2', 'run-1', 'turn-1', 'call-2'),
      });

      assert.deepEqual(
        await coordinator
          .sourceCapabilities()
          .remember(snapshot('run-1', 'turn-1', 'call-2', 'Prefer Rust.')),
        { status: 'not_applicable', requestedItems: [] },
      );
      assert.equal(observed.length, 1);
      await coordinator.close();
    });
  });

  test('drains every bounded batch through a frozen boundary before receipting the trigger', async () => {
    await withMemoryWriter(async (writer) => {
      const entries: Array<{ ordinal: number; event: RuntimeEvent }> = Array.from(
        { length: 120 },
        (_, index) => ({
          ordinal: index + 1,
          event: textEvent(`e${index + 1}`, 'run-old', `turn-old-${index + 1}`, `old${index + 1}`),
        }),
      );
      entries.push(
        {
          ordinal: 121,
          event: textEvent(
            'event-trigger',
            'run-current',
            'turn-current',
            'Remember that I prefer concise Chinese.',
          ),
        },
        {
          ordinal: 122,
          event: toolCallEvent('event-memory-call', 'run-current', 'turn-current', 'memory-call'),
        },
      );
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'not_applicable',
            requestedItems: [],
            incidentalItems: [
              {
                ...proposalItem('Historical detail one.', 'global', 'e1', 'old1'),
                kind: 'note',
              },
            ],
          }),
          new Error('provider unavailable'),
          proposal('The user prefers concise Chinese.', 'global', 'event-trigger'),
        ],
        observed,
      });
      const source = snapshot(
        'run-current',
        'turn-current',
        'memory-call',
        'Remember that I prefer concise Chinese.',
        'event-trigger',
      );

      const failed = await coordinator.sourceCapabilities().remember(source);

      assert.equal(failed.status, 'unavailable');
      assert.equal(observed.length, 2, 'the failed final batch was reached once');
      assert.doesNotMatch(observed[0]!.prompt, /event:event-trigger/);
      assert.match(observed[1]!.prompt, /event:event-trigger/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 120);

      const result = await coordinator.sourceCapabilities().remember(source);

      assert.equal(result.status, 'remembered');
      assert.equal(observed.length, 3, 'retry resumes at the failed batch');
      assert.match(observed[2]!.prompt, /event:event-trigger/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 121);
      const stored = await writer.searchByKeys({
        terms: ['response preference'],
        match: 'exact',
      });
      assert.deepEqual(
        stored.map(({ item }) => item.content),
        ['The user prefers concise Chinese.', 'Historical detail one.'],
      );

      assert.deepEqual(await coordinator.sourceCapabilities().remember(source), result);
      assert.equal(observed.length, 3, 'the final trigger receipt must replay exactly');
      await coordinator.close();
    });
  });

  test('localizes an explicit reference with one bounded same-Session search call', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        {
          ordinal: 1,
          event: textEvent('event-old', 'run-1', 'turn-1', 'My preferred accent color is violet.'),
        },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          proposal('The user prefers violet as an accent color.', 'global', 'event-old'),
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['violet', 'accent color'], roles: ['user'] },
          }),
          JSON.stringify({
            status: 'resolved',
            requestedItems: [
              proposalItem(
                'The user prefers violet as an accent color.',
                'global',
                'event-old',
                'violet',
              ),
            ],
          }),
        ],
        observed,
      });

      await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'My preferred accent color is violet.'));
      entries.push(
        {
          ordinal: 3,
          event: textEvent(
            'event-current',
            'run-2',
            'turn-2',
            'Remember the color preference I mentioned earlier.',
          ),
        },
        { ordinal: 4, event: toolCallEvent('event-call-2', 'run-2', 'turn-2', 'call-2') },
      );

      const remembered = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-2',
            'turn-2',
            'call-2',
            'Remember the color preference I mentioned earlier.',
          ),
        );

      assert.equal(remembered.status, 'remembered');
      assert.equal(observed.length, 3);
      assert.doesNotMatch(observed[1]!.prompt, /violet/);
      assert.match(observed[2]!.prompt, /violet/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      await coordinator.close();
    });
  });

  test('rechecks Incognito before a requested localized model call', async () => {
    await withMemoryWriter(async (writer) => {
      const policyState = { incognito: false };
      const entries = [
        { ordinal: 1, event: textEvent('event-old', 'run-1', 'turn-1', 'Prefer violet.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['violet'], roles: ['user'] },
          }),
        ],
        observed,
        policyState,
        afterModelCall: () => {
          policyState.incognito = true;
        },
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Remember the earlier preference.'));
      assert.equal(result.status, 'unavailable');
      assert.equal(
        observed.length,
        1,
        'the localized model call must not start after policy closes',
      );
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(await writer.searchByKeys({ terms: ['violet'], match: 'exact' }), []);
      await coordinator.close();
    });
  });

  test('keeps the Cursor unchanged across provider and schema failures, then commits a valid empty result', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Remember this.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          new Error('provider unavailable'),
          '{"status":"complete"}',
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['Remember this'], roles: ['user'] },
          }),
          JSON.stringify({ status: 'cannot_resolve', requestedItems: [] }),
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'not_applicable',
            requestedItems: [],
            incidentalItems: [],
          }),
        ],
      });
      const source = snapshot('run-1', 'turn-1', 'call-1', 'Remember this.');
      assert.equal((await coordinator.sourceCapabilities().remember(source)).status, 'unavailable');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.equal((await coordinator.sourceCapabilities().remember(source)).status, 'unavailable');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.equal((await coordinator.sourceCapabilities().remember(source)).status, 'unavailable');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(await coordinator.sourceCapabilities().remember(source), {
        status: 'not_applicable',
        requestedItems: [],
      });
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 1);
      assert.deepEqual(await writer.searchByKeys({ terms: ['anything'], match: 'exact' }), []);
      await coordinator.close();
    });
  });
});

function createCoordinator(input: {
  writer: InteractiveLongTermMemoryWriter;
  entries: Array<{ ordinal: number; event: RuntimeEvent }>;
  outputs: Array<string | Error>;
  observed?: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }>;
  policyState?: { incognito: boolean };
  afterModelCall?: () => void;
}): HostMemoryExtractionCoordinator {
  const policyState = input.policyState ?? { incognito: false };
  let call = 0;
  return new HostMemoryExtractionCoordinator({
    store: input.writer,
    policy: {
      getSnapshot: async () =>
        ({
          revision: 1,
          policy: {
            ...createDefaultRuntimePolicy(),
            privacy: { incognitoActive: policyState.incognito },
          },
        }) satisfies Awaited<ReturnType<RuntimePolicyReader['getSnapshot']>>,
    },
    sessions: { readHeader: async () => header() },
    runtimeEvents: { readSessionRuntimeEventEntries: async () => [...input.entries] },
    model: {
      generate: async ({ snapshot: source, prompt }) => {
        input.observed?.push({ snapshot: source, prompt });
        const output = input.outputs[call++];
        if (output === undefined) throw new Error('Unexpected model call');
        if (output instanceof Error) throw output;
        input.afterModelCall?.();
        return output;
      },
    },
    lane: new MemoryExtractionSessionLane(),
    acquireResidency: () => ({ release: () => {} }),
    now: () => 2_000,
  });
}

function snapshot(
  runId: string,
  turnId: string,
  toolCallId: string,
  text: string,
  indexedEventId?: string,
): MemoryExtractionSourceSnapshot {
  return {
    trigger: 'remember',
    sourceHeader: header(),
    sourceSystemPrompt: 'original system',
    sourceMessages: [{ role: 'user', content: text }],
    ...(indexedEventId ? { sourceEventMessagePositions: { [indexedEventId]: [0] } } : {}),
    sourceTools: {
      memory_remember: { description: 'Remember', inputSchema: {} },
    },
    sourceActiveTools: ['memory_remember'],
    sourceProviderOptions: { openai: { reasoningEffort: 'medium' } },
    sessionId: 'session-1',
    runId,
    turnId,
    workspaceKey: '/workspace/maka',
    toolCallId,
  };
}

function proposal(content: string, scope: 'global' | 'workspace', eventId: string): string {
  return JSON.stringify({
    status: 'complete',
    coverageStatus: 'processed',
    requestedStatus: 'resolved',
    requestedItems: [proposalItem(content, scope, eventId)],
    incidentalItems: [],
  });
}

function proposalItem(
  content: string,
  scope: 'global' | 'workspace',
  eventId: string,
  quote = content.includes('concise')
    ? 'concise Chinese'
    : content.includes('English')
      ? 'detailed English'
      : content.includes('violet')
        ? 'violet'
        : 'Prefer Rust',
) {
  return {
    content,
    kind: 'preference',
    statementType: 'fact',
    temporalType: 'undated',
    eventStartedAt: null,
    eventEndedAt: null,
    scope,
    keys: [{ key: 'response preference', type: 'concept' }],
    evidence: [{ sourceRef: `event:${eventId}`, quote }],
  };
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/maka',
    cwd: '/workspace/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Memory test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function textEvent(id: string, runId: string, turnId: string, text: string): RuntimeEvent {
  return {
    id,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1_000,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}

function modelTextEvent(id: string, runId: string, turnId: string, text: string): RuntimeEvent {
  return {
    ...textEvent(id, runId, turnId, text),
    role: 'model',
    author: 'agent',
  };
}

function toolCallEvent(
  id: string,
  runId: string,
  turnId: string,
  toolCallId: string,
): RuntimeEvent {
  return {
    id,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1_001,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'memory_remember', args: {} },
  };
}

async function withMemoryWriter(
  operation: (writer: InteractiveLongTermMemoryWriter) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-extraction-'));
  let owner: InteractiveRootOwner | undefined;
  let writer: InteractiveLongTermMemoryWriter | undefined;
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    owner = (await tryAcquireInteractiveRootOwner(capability)) ?? undefined;
    assert.ok(owner);
    writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
    await operation(writer);
  } finally {
    writer?.close();
    await owner?.close();
    await rm(root, { recursive: true, force: true });
  }
}
