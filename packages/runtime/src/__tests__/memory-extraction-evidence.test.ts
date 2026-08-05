import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  MAX_MEMORY_EVIDENCE_JSON_CHARS,
  memoryExtractionEvidenceJsonSize,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  renderMemoryExtractionEvidence,
  searchSameSessionMemoryHistory,
  type MemoryExtractionEventEntry,
} from '../memory-extraction-evidence.js';

describe('Memory Extraction evidence planning', () => {
  test('never cuts overlapping Tool episodes and omits failed or empty results', () => {
    const entries = withOrdinals([
      textEvent('user', 'user', 'Remember the durable result.'),
      callEvent('call-event-1', 'call-1', 'Read'),
      callEvent('call-event-2', 'call-2', 'Bash'),
      resultEvent('result-event-1', 'call-1', 'Read', { text: 'durable result' }),
      resultEvent('result-event-2', 'call-2', 'Bash', 'failed', true),
      callEvent('call-event-3', 'call-3', 'List'),
      resultEvent('result-event-3', 'call-3', 'List', {}),
      textEvent('next', 'model', 'Done.'),
    ]);
    const userEvidence = projectMemoryExtractionEvidence([entries[0]!.event]);
    const narrow = planMemoryCoverage({
      pendingEntries: entries,
      allEntries: entries,
      boundaryOrdinal: 8,
      maxEvidenceJsonChars: memoryExtractionEvidenceJsonSize(userEvidence) + 10,
    });
    assert.deepEqual(
      narrow?.entries.map(({ ordinal }) => ordinal),
      [1],
      'the Cursor stops before the first evidence record omitted from the model view',
    );
    assert.deepEqual(
      narrow?.evidence.map(({ sourceRef }) => sourceRef),
      ['event:user'],
    );

    const complete = planMemoryCoverage({
      pendingEntries: entries,
      allEntries: entries,
      boundaryOrdinal: 8,
    });
    assert.equal(complete?.entries.at(-1)?.ordinal, 8);
    assert.deepEqual(
      complete?.evidence.map(({ sourceRef }) => sourceRef),
      ['event:user', 'tool:call-event-1', 'event:next'],
    );
  });

  test('blocks an unresolved Tool Call until its own Run is terminal', () => {
    const call = withOrdinals([callEvent('call-event', 'call-1', 'Read')]);
    const laterResult = {
      ordinal: 2,
      event: resultEvent('result-event', 'call-1', 'Read', { text: 'late' }),
    };
    assert.equal(
      planMemoryCoverage({
        pendingEntries: call,
        allEntries: [...call, laterResult],
        boundaryOrdinal: 1,
      }),
      undefined,
      'a response beyond the frozen boundary still makes the cut unsafe',
    );
    assert.equal(
      planMemoryCoverage({
        pendingEntries: call,
        allEntries: call,
        boundaryOrdinal: 1,
      }),
      undefined,
    );

    const terminal = { ordinal: 2, event: terminalEvent('terminal-event') };
    assert.equal(
      planMemoryCoverage({
        pendingEntries: [...call, terminal],
        allEntries: [...call, terminal],
        boundaryOrdinal: 2,
      })?.entries.at(-1)?.ordinal,
      2,
    );

    const actionTerminal = {
      ordinal: 2,
      event: {
        ...event('action-terminal', 'system', { kind: 'text', text: '' }),
        actions: { endInvocation: true },
      },
    };
    assert.equal(
      planMemoryCoverage({
        pendingEntries: [...call, actionTerminal],
        allEntries: [...call, actionTerminal],
        boundaryOrdinal: 2,
      })?.entries.at(-1)?.ordinal,
      2,
    );
  });

  test('prioritizes requested evidence and enforces one final JSON budget', () => {
    const requestedText = `Remember this exact requested detail: ${'r'.repeat(1_000)}`;
    const requested = textEvent('requested', 'user', requestedText);
    const priority = projectMemoryExtractionEvidence([requested]);
    const pending = withOrdinals([
      textEvent('coverage', 'model', `Reusable detail ${'x'.repeat(8_000)}.`),
    ]);
    const plan = planMemoryCoverage({
      pendingEntries: pending,
      allEntries: pending,
      boundaryOrdinal: 1,
      priorityEvidence: priority,
      maxEvidenceJsonChars: 1_800,
    });
    assert.ok(plan);
    assert.equal(plan.evidence[0]?.sourceRef, 'event:requested');
    assert.equal(plan.evidence[0]?.text, requestedText);
    assert.equal(plan.evidence[1]?.sourceRef, 'event:coverage');
    assert.ok(memoryExtractionEvidenceJsonSize(plan.evidence) <= 1_800);
    assert.match(JSON.stringify(renderMemoryExtractionEvidence(plan.evidence)[0]), /Remember this/);
  });

  test('does not guess text positions and returns a bounded hit-centered history snippet', () => {
    const repeated = textEvent('repeated', 'user', 'same preference');
    const ambiguous = projectMemoryExtractionEvidence([repeated]);
    assert.equal(ambiguous[0]?.text, 'same preference');

    const old = textEvent(
      'old',
      'user',
      `${'prefix '.repeat(900)}My preferred accent color is violet.`,
    );
    const entries = withOrdinals([old]);
    const localized = searchSameSessionMemoryHistory(entries, 1, {
      terms: ['violet', 'accent color'],
      roles: ['user'],
    });
    const evidence = projectMemoryExtractionEvidence(
      localized.map(({ event }) => event),
      { snippetTerms: ['violet', 'accent color'] },
    );
    assert.match(evidence[0]!.text, /violet/);
    assert.ok(Array.from(evidence[0]!.text).length <= 4_000);
    assert.ok(memoryExtractionEvidenceJsonSize(evidence) <= MAX_MEMORY_EVIDENCE_JSON_CHARS);

    const toolEntries = withOrdinals([
      callEvent('tail-call', 'tail-id', 'Read'),
      resultEvent('tail-result', 'tail-id', 'Read', {
        text: `${'discard '.repeat(900)}TAIL_TOOL_MEMORY_KEYWORD`,
      }),
    ]);
    const toolHits = searchSameSessionMemoryHistory(toolEntries, 2, {
      terms: ['TAIL_TOOL_MEMORY_KEYWORD'],
      roles: ['tool'],
    });
    const toolEvidence = projectMemoryExtractionEvidence(
      toolHits.map(({ event }) => event),
      { snippetTerms: ['TAIL_TOOL_MEMORY_KEYWORD'] },
    );
    assert.match(toolEvidence[0]!.text, /TAIL_TOOL_MEMORY_KEYWORD/);
    assert.ok(Array.from(toolEvidence[0]!.text).length <= 4_000);
  });

  test('pairs Tool evidence within one invocation when call ids repeat', () => {
    const firstCall = withIdentity(callEvent('call-1a', 'shared', 'Read'), 'invocation-a', 'run-a');
    const firstResult = withIdentity(
      resultEvent('result-1a', 'shared', 'Read', { value: 'first' }),
      'invocation-a',
      'run-a',
    );
    const secondCall = withIdentity(
      callEvent('call-1b', 'shared', 'Read'),
      'invocation-b',
      'run-b',
    );
    const secondResult = withIdentity(
      resultEvent('result-1b', 'shared', 'Read', { value: 'second' }),
      'invocation-b',
      'run-b',
    );
    const evidence = projectMemoryExtractionEvidence([
      firstCall,
      secondCall,
      firstResult,
      secondResult,
    ]);
    assert.equal(evidence.length, 2);
    assert.match(evidence[0]!.text, /first/);
    assert.match(evidence[1]!.text, /second/);

    const entries = withOrdinals([firstCall, secondCall, firstResult, secondResult]);
    assert.equal(
      planMemoryCoverage({
        pendingEntries: entries.slice(0, 3),
        allEntries: entries,
        boundaryOrdinal: 3,
      }),
      undefined,
      'the first invocation result must not close the second invocation call',
    );

    const continuedCall = withIdentity(
      callEvent('continued-call', 'continued-id', 'Read'),
      'invocation-continued',
      'run-before',
    );
    const continuedResult = withIdentity(
      resultEvent('continued-result', 'continued-id', 'Read', { value: 'continued' }),
      'invocation-continued',
      'run-after',
    );
    assert.match(
      projectMemoryExtractionEvidence([continuedCall, continuedResult])[0]!.text,
      /continued/,
      'Maka Tool identity is invocationId plus provider toolCallId',
    );
  });

  test('does not consume an indivisible Tool episode whose evidence cannot fit', () => {
    const calls = Array.from({ length: 61 }, (_, index) =>
      callEvent(`large-call-${index}`, `large-id-${index}`, 'Read'),
    );
    const results = Array.from({ length: 61 }, (_, index) =>
      resultEvent(`large-result-${index}`, `large-id-${index}`, 'Read', {
        text: `result-${index}-${'x'.repeat(4_000)}`,
      }),
    );
    const entries = withOrdinals([...calls, ...results]);
    const plan = planMemoryCoverage({
      pendingEntries: entries,
      allEntries: entries,
      boundaryOrdinal: entries.length,
      maxEvidenceJsonChars: 800,
    });

    assert.equal(plan, undefined);
  });

  test('renders indexed Provider-prefix evidence without duplicating its text', () => {
    const event = textEvent('indexed-user', 'user', 'This text already exists in the prefix.');
    const evidence = projectMemoryExtractionEvidence([event]);
    const rendered = renderMemoryExtractionEvidence(evidence, { 'indexed-user': [3] });

    assert.deepEqual(rendered, [
      {
        sourceRef: 'event:indexed-user',
        type: 'user_message',
        observedAt: 0,
        messagePositions: [3],
      },
    ]);
    assert.equal(JSON.stringify(rendered).includes('already exists'), false);
  });
});

function withOrdinals(events: readonly RuntimeEvent[]): MemoryExtractionEventEntry[] {
  return events.map((event, index) => ({ ordinal: index + 1, event }));
}

function textEvent(id: string, role: 'user' | 'model', text: string): RuntimeEvent {
  return event(id, role, { kind: 'text', text });
}

function callEvent(id: string, callId: string, name: string): RuntimeEvent {
  return event(id, 'model', { kind: 'function_call', id: callId, name, args: {} });
}

function resultEvent(
  id: string,
  callId: string,
  name: string,
  result: unknown,
  isError = false,
): RuntimeEvent {
  return event(id, 'tool', {
    kind: 'function_response',
    id: callId,
    name,
    result,
    ...(isError ? { isError: true } : {}),
  });
}

function event(
  id: string,
  role: RuntimeEvent['role'],
  content: NonNullable<RuntimeEvent['content']>,
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'agent',
    content,
  };
}

function terminalEvent(id: string): RuntimeEvent {
  return { ...event(id, 'system', { kind: 'text', text: '' }), status: 'completed' };
}

function withIdentity(eventValue: RuntimeEvent, invocationId: string, runId: string): RuntimeEvent {
  return { ...eventValue, invocationId, runId, turnId: `${runId}-turn` };
}
