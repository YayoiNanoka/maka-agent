import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deriveMemoryTemporalStatus,
  isMemoryItemKind,
  isMemoryKeyType,
  normalizeLongTermMemoryContent,
} from '../long-term-memory.js';

describe('long-term memory contract', () => {
  test('derives temporal status at read time without changing the fact', () => {
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'undated', eventStartedAt: null, eventEndedAt: null },
        100,
      ),
      'timeless',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'point', eventStartedAt: 200, eventEndedAt: null },
        100,
      ),
      'upcoming',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'point', eventStartedAt: 100, eventEndedAt: 200 },
        100,
      ),
      'ongoing',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'point', eventStartedAt: 100, eventEndedAt: null },
        100,
      ),
      'elapsed',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'point', eventStartedAt: 100, eventEndedAt: 200 },
        150,
      ),
      'ongoing',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'interval', eventStartedAt: 100, eventEndedAt: 200 },
        200,
      ),
      'elapsed',
    );
    assert.equal(
      deriveMemoryTemporalStatus(
        { temporalType: 'open_ended', eventStartedAt: 100, eventEndedAt: null },
        1_000,
      ),
      'ongoing',
    );
  });

  test('fails closed over invalid temporal combinations', () => {
    assert.throws(
      () =>
        deriveMemoryTemporalStatus(
          { temporalType: 'undated', eventStartedAt: 1, eventEndedAt: null },
          100,
        ),
      /cannot carry event bounds/,
    );
    assert.throws(
      () =>
        deriveMemoryTemporalStatus(
          { temporalType: 'interval', eventStartedAt: 100, eventEndedAt: null },
          100,
        ),
      /requires an end/,
    );
    assert.throws(
      () =>
        deriveMemoryTemporalStatus(
          { temporalType: 'point', eventStartedAt: 200, eventEndedAt: 100 },
          100,
        ),
      /later than its start/,
    );
  });

  test('keeps provisional categories and key types closed', () => {
    assert.equal(isMemoryItemKind('preference'), true);
    assert.equal(isMemoryItemKind('misc'), false);
    assert.equal(isMemoryKeyType('code'), true);
    assert.equal(isMemoryKeyType('keyword'), false);
  });

  test('normalizes long-term memory content without the legacy Memory module', () => {
    assert.deepEqual(normalizeLongTermMemoryContent('  concise\u0000answer\u200b  '), {
      ok: true,
      value: 'concise answer',
    });
    assert.equal(normalizeLongTermMemoryContent('   ').ok, false);
    assert.equal(normalizeLongTermMemoryContent(`lone\uD800surrogate`).ok, false);
    assert.equal(normalizeLongTermMemoryContent('💾'.repeat(2_000)).ok, true);
    assert.equal(normalizeLongTermMemoryContent('💾'.repeat(2_001)).ok, false);
  });
});
