import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import { projectMemoryExtractionEvidence } from '../memory-extraction-evidence.js';
import {
  admitMemoryProposalItem,
  buildFirstMemoryProposalPrompt,
  parseMemoryProposal,
} from '../memory-extraction-proposal.js';

describe('bounded Memory Extraction', () => {
  test('projects user, assistant, and successful Tool evidence without thinking or failed tools', () => {
    const evidence = projectMemoryExtractionEvidence([
      event('user-1', 'user', { kind: 'text', text: 'Use concise Chinese answers.' }),
      event('thinking-1', 'model', { kind: 'thinking', text: 'private reasoning' }),
      event('assistant-1', 'model', { kind: 'text', text: 'Understood.' }),
      event('tool-call-1', 'model', {
        kind: 'function_call',
        id: 'call-1',
        name: 'Read',
        args: { path: 'README.md' },
      }),
      event('tool-result-1', 'tool', {
        kind: 'function_response',
        id: 'call-1',
        name: 'Read',
        result: { text: 'Maka' },
      }),
      event('tool-call-2', 'model', {
        kind: 'function_call',
        id: 'call-2',
        name: 'Bash',
        args: { cmd: 'false' },
      }),
      event('tool-result-2', 'tool', {
        kind: 'function_response',
        id: 'call-2',
        name: 'Bash',
        result: 'failed',
        isError: true,
      }),
    ]);

    assert.deepEqual(
      evidence.map(({ sourceRef, type }) => ({ sourceRef, type })),
      [
        { sourceRef: 'event:user-1', type: 'user_message' },
        { sourceRef: 'event:assistant-1', type: 'assistant_message' },
        { sourceRef: 'tool:tool-call-1', type: 'tool_exchange' },
      ],
    );
    assert.equal(
      evidence.some(({ text }) => text.includes('private reasoning')),
      false,
    );
    const prompt = buildFirstMemoryProposalPrompt({
      trigger: 'extract',
      now: 61_234,
      evidence,
    });
    assert.match(prompt, /Current time: 60000/);
    assert.match(prompt, /"observedAt":0/);
  });

  test('parses only the strict top-level Proposal schema', () => {
    const valid = JSON.stringify({
      status: 'complete',
      coverageStatus: 'processed',
      requestedStatus: 'not_applicable',
      requestedItems: [],
      incidentalItems: [],
    });
    assert.equal(parseMemoryProposal(valid)?.status, 'complete');
    assert.equal(parseMemoryProposal(`\`\`\`json\n${valid}\n\`\`\``), undefined);
    assert.equal(
      parseMemoryProposal(JSON.stringify({ ...JSON.parse(valid), extra: true })),
      undefined,
    );
    assert.equal(
      parseMemoryProposal(
        JSON.stringify({
          ...JSON.parse(valid),
          requestedStatus: 'resolved',
          requestedItems: [],
        }),
      ),
      undefined,
    );
  });

  test('requires exact evidence quotes while allowing model-selected global scope', () => {
    const sourceEvent = event('user-1', 'user', {
      kind: 'text',
      text: 'Please answer in concise Chinese.',
    });
    const evidence = projectMemoryExtractionEvidence([sourceEvent]);
    const byRef = new Map(evidence.map((entry) => [entry.sourceRef, entry]));
    const base = {
      content: 'The user prefers concise Chinese answers.',
      kind: 'preference' as const,
      statementType: 'fact' as const,
      temporalType: 'undated' as const,
      eventStartedAt: null,
      eventEndedAt: null,
      scope: 'global' as const,
      keys: [{ key: 'concise Chinese', type: 'concept' as const }],
      evidence: [{ sourceRef: 'event:user-1', quote: 'concise Chinese' }],
    };
    assert.equal(admitMemoryProposalItem(base, byRef)?.citedEvents[0]?.id, 'user-1');
    assert.equal(
      admitMemoryProposalItem(
        {
          ...base,
          temporalType: 'point',
          eventStartedAt: 61_234,
        },
        byRef,
      )?.eventStartedAt,
      60_000,
    );
    assert.equal(
      admitMemoryProposalItem(
        { ...base, evidence: [{ sourceRef: 'event:user-1', quote: 'not present' }] },
        byRef,
      ),
      undefined,
    );
    assert.equal(
      admitMemoryProposalItem({ ...base, kind: 'knowledge', content: 'Maka uses SQLite.' }, byRef)
        ?.scopeType,
      'global',
    );
  });
});

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
