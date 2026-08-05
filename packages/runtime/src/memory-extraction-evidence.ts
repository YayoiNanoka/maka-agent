import { isTerminalRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';

export interface MemoryExtractionEventEntry {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
}

export interface MemoryExtractionEvidence {
  readonly sourceRef: string;
  readonly type: 'user_message' | 'assistant_message' | 'tool_exchange';
  /** Exact bounded text shown to the model and used for admission. */
  readonly text: string;
  readonly events: readonly RuntimeEvent[];
}

export interface MemoryCoveragePlan {
  readonly entries: readonly MemoryExtractionEventEntry[];
  readonly evidence: readonly MemoryExtractionEvidence[];
}

export const MAX_MEMORY_EVIDENCE_JSON_CHARS = 12_000;
const MAX_COVERAGE_EVENTS = 120;
const MAX_EVIDENCE_TEXT_CHARS = 4_000;
const MIN_EVIDENCE_TEXT_CHARS = 64;
const MAX_LOCALIZED_TURNS = 7;

/**
 * Select the largest bounded, continuous Event prefix whose Cursor boundary
 * cannot split a Tool Call/Result episode. Overlapping call intervals naturally
 * cover parallel sequences such as C1,C2,R1,R2.
 */
export function planMemoryCoverage(input: {
  readonly pendingEntries: readonly MemoryExtractionEventEntry[];
  readonly allEntries: readonly MemoryExtractionEventEntry[];
  readonly boundaryOrdinal: number;
  readonly priorityEvidence?: readonly MemoryExtractionEvidence[];
  readonly maxEvidenceJsonChars?: number;
  readonly sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>;
}): MemoryCoveragePlan | undefined {
  const limit = Math.min(input.pendingEntries.length, MAX_COVERAGE_EVENTS);
  const unsafeRanges = toolUnsafeRanges(toolCallIntervals(input.allEntries), input.boundaryOrdinal);
  const priority = input.priorityEvidence ?? [];
  const budget = input.maxEvidenceJsonChars ?? MAX_MEMORY_EVIDENCE_JSON_CHARS;
  const fittedPriority = fitMemoryExtractionEvidence(
    priority,
    budget,
    input.sourceEventMessagePositions,
  );
  if (!fittedPriority) return undefined;
  let selected: MemoryCoveragePlan | undefined;
  const candidateCounts: number[] = [];
  let unsafeRangeIndex = 0;

  for (let count = 1; count <= input.pendingEntries.length; count += 1) {
    const ordinal = input.pendingEntries[count - 1]!.ordinal;
    while (unsafeRanges[unsafeRangeIndex]?.end < ordinal) unsafeRangeIndex += 1;
    const unsafeRange = unsafeRanges[unsafeRangeIndex];
    if (unsafeRange && unsafeRange.start <= ordinal && ordinal <= unsafeRange.end) continue;
    candidateCounts.push(count);
    // Ordinary batches stop at the configured bound. If that bound falls
    // inside one indivisible Tool episode, continue only until its next safe
    // Cursor cut so the Session cannot deadlock behind that episode forever.
    if (count >= limit) break;
  }

  for (const count of candidateCounts) {
    const candidateEntries = input.pendingEntries.slice(0, count);
    const coverage = projectMemoryExtractionEvidence(candidateEntries.map(({ event }) => event));
    const fitted = fitCoverageAroundPriority(
      fittedPriority,
      coverage,
      budget,
      input.sourceEventMessagePositions,
    );
    if (!fitted) continue;

    const fittedRefs = new Set(fitted.map(({ sourceRef }) => sourceRef));
    const firstOmitted = coverage.find(({ sourceRef }) => !fittedRefs.has(sourceRef));
    if (!firstOmitted) {
      selected = { entries: candidateEntries, evidence: fitted };
      continue;
    }

    const firstOmittedOrdinal = Math.min(
      ...firstOmitted.events.map(
        (event) =>
          input.pendingEntries.find((entry) => entry.event.id === event.id)?.ordinal ?? Infinity,
      ),
    );
    const safeCount = candidateCounts
      .filter(
        (candidateCount) =>
          candidateCount < count &&
          input.pendingEntries[candidateCount - 1]!.ordinal < firstOmittedOrdinal,
      )
      .at(-1);
    if (!safeCount) continue;
    const entries = input.pendingEntries.slice(0, safeCount);
    const includedEventIds = new Set(entries.map(({ event }) => event.id));
    const priorityRefs = new Set(fittedPriority.map(({ sourceRef }) => sourceRef));
    selected = {
      entries,
      evidence: fitted.filter(
        (entry) =>
          priorityRefs.has(entry.sourceRef) ||
          entry.events.every((event) => includedEventIds.has(event.id)),
      ),
    };
  }
  return selected;
}

/** Projects evidence without thinking, partial Events, failed/empty Tools, or raw results. */
export function projectMemoryExtractionEvidence(
  events: readonly RuntimeEvent[],
  options: {
    readonly snippetTerms?: readonly string[];
  } = {},
): readonly MemoryExtractionEvidence[] {
  const stable = events.filter((event) => !event.partial);
  const responses = new Map<string, RuntimeEvent>();
  for (const event of stable) {
    if (event.content?.kind === 'function_response') {
      responses.set(toolExchangeKey(event, event.content.id), event);
    }
  }

  const projected: MemoryExtractionEvidence[] = [];
  for (const event of stable) {
    const content = event.content;
    if (!content) continue;
    if (content.kind === 'text' && (event.role === 'user' || event.role === 'model')) {
      const fullText = normalizeEvidenceText(content.text);
      if (!fullText) continue;
      projected.push({
        sourceRef: `event:${event.id}`,
        type: event.role === 'user' ? 'user_message' : 'assistant_message',
        text: boundedEvidenceText(fullText, options.snippetTerms),
        events: [event],
      });
      continue;
    }
    if (content.kind !== 'function_call' || isMemoryToolName(content.name)) continue;
    const response = responses.get(toolExchangeKey(event, content.id));
    if (
      !response ||
      response.content?.kind !== 'function_response' ||
      response.content.name !== content.name ||
      response.content.isError ||
      isEmptyToolResult(response.content.result)
    ) {
      continue;
    }
    const text = normalizeEvidenceText(
      `Tool ${content.name}\nArguments: ${boundedJson(content.args, options.snippetTerms)}\nResult: ${boundedJson(response.content.result, options.snippetTerms)}`,
    );
    if (!text) continue;
    projected.push({
      sourceRef: `tool:${event.id}`,
      type: 'tool_exchange',
      text: boundedEvidenceText(text, options.snippetTerms),
      events: [event, response],
    });
  }
  return projected;
}

/**
 * Keep every evidence record represented while shrinking supplemental text to
 * the actual serialized JSON budget. Returning undefined means even the record
 * identities cannot fit and the Cursor must not advance.
 */
export function fitMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  maxJsonChars = MAX_MEMORY_EVIDENCE_JSON_CHARS,
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): readonly MemoryExtractionEvidence[] | undefined {
  if (!Number.isSafeInteger(maxJsonChars) || maxJsonChars < 1) return undefined;
  if (memoryExtractionEvidenceJsonSize(evidence, sourceEventMessagePositions) <= maxJsonChars) {
    return evidence;
  }
  let low = MIN_EVIDENCE_TEXT_CHARS;
  let high = MAX_EVIDENCE_TEXT_CHARS;
  let best: readonly MemoryExtractionEvidence[] | undefined;
  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    const candidate = evidence.map((entry) => ({
      ...entry,
      text: sliceCodePoints(entry.text, cap),
    }));
    if (memoryExtractionEvidenceJsonSize(candidate, sourceEventMessagePositions) <= maxJsonChars) {
      best = candidate;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }
  return best;
}

export function memoryExtractionEvidenceJsonSize(
  evidence: readonly MemoryExtractionEvidence[],
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): number {
  return JSON.stringify(renderMemoryExtractionEvidence(evidence, sourceEventMessagePositions))
    .length;
}

export function renderMemoryExtractionEvidence(
  evidence: readonly MemoryExtractionEvidence[],
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
) {
  return evidence.map(({ sourceRef, type, text, events }) => {
    const messagePositions = uniqueSorted(
      events.flatMap((event) => sourceEventMessagePositions?.[event.id] ?? []),
    );
    const everyEventIndexed =
      sourceEventMessagePositions !== undefined &&
      events.every((event) => (sourceEventMessagePositions[event.id]?.length ?? 0) > 0);
    return {
      sourceRef,
      type,
      observedAt: minuteTimestamp(Math.max(0, ...events.map((event) => event.ts))),
      ...(everyEventIndexed ? { messagePositions } : { text }),
    };
  });
}

/** Preserve requested evidence once fitted; only coverage text may shrink. */
function fitCoverageAroundPriority(
  priority: readonly MemoryExtractionEvidence[],
  coverage: readonly MemoryExtractionEvidence[],
  maxJsonChars: number,
  sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>,
): readonly MemoryExtractionEvidence[] | undefined {
  const priorityRefs = new Set(priority.map(({ sourceRef }) => sourceRef));
  const remaining = coverage.filter(({ sourceRef }) => !priorityRefs.has(sourceRef));
  const merged = [...priority, ...remaining];
  if (memoryExtractionEvidenceJsonSize(merged, sourceEventMessagePositions) <= maxJsonChars) {
    return merged;
  }
  if (remaining.length === 0) return undefined;

  const fit = (entries: readonly MemoryExtractionEvidence[]) => {
    let low = MIN_EVIDENCE_TEXT_CHARS;
    let high = MAX_EVIDENCE_TEXT_CHARS;
    let best: readonly MemoryExtractionEvidence[] | undefined;
    while (low <= high) {
      const cap = Math.floor((low + high) / 2);
      const candidate = [
        ...priority,
        ...entries.map((entry) => ({ ...entry, text: sliceCodePoints(entry.text, cap) })),
      ];
      if (
        memoryExtractionEvidenceJsonSize(candidate, sourceEventMessagePositions) <= maxJsonChars
      ) {
        best = candidate;
        low = cap + 1;
      } else {
        high = cap - 1;
      }
    }
    return best;
  };

  const fitted = fit(remaining);
  if (fitted) return fitted;

  // Keep only a continuous evidence prefix. If a record no longer fits, later
  // records must not remain visible while the Cursor silently consumes the
  // omitted Event. planMemoryCoverage moves the Cursor to the preceding safe
  // boundary and leaves the remainder for the next extraction.
  let low = 0;
  let high = remaining.length - 1;
  let best: readonly MemoryExtractionEvidence[] | undefined;
  while (low <= high) {
    const keepCount = Math.floor((low + high) / 2);
    const candidate = fit(remaining.slice(0, keepCount));
    if (candidate) {
      best = candidate;
      low = keepCount + 1;
    } else {
      high = keepCount - 1;
    }
  }
  return best;
}

/** Rank matching Turns by term coverage and recency, then add a one-Turn neighborhood. */
export function searchSameSessionMemoryHistory(
  entries: readonly MemoryExtractionEventEntry[],
  throughOrdinal: number,
  search: { readonly terms: readonly string[]; readonly roles?: readonly string[] },
): readonly MemoryExtractionEventEntry[] {
  const eligible = entries.filter(
    ({ ordinal, event }) => ordinal <= throughOrdinal && !event.partial && !isMemoryEvent(event),
  );
  const turns: Array<{ key: string; entries: MemoryExtractionEventEntry[] }> = [];
  for (const entry of eligible) {
    const key = `${entry.event.runId}\0${entry.event.turnId}`;
    const last = turns.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else turns.push({ key, entries: [entry] });
  }

  const terms = search.terms.map((term) => normalizeEvidenceText(term).toLowerCase());
  const allowedRoles = search.roles ? new Set(search.roles) : undefined;
  const hits = turns
    .map((turn, index) => ({
      index,
      score: terms.filter((term) =>
        turn.entries.some(({ event }) => {
          if (allowedRoles && !allowedRoles.has(historyRole(event))) return false;
          return normalizeEvidenceText(safeJson(event.content)).toLowerCase().includes(term);
        }),
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index);

  const selected = new Set<number>();
  for (const hit of hits) {
    for (const index of [hit.index, hit.index - 1, hit.index + 1]) {
      if (index < 0 || index >= turns.length || selected.has(index)) continue;
      if (selected.size >= MAX_LOCALIZED_TURNS) break;
      selected.add(index);
    }
    if (selected.size >= MAX_LOCALIZED_TURNS) break;
  }
  return [...selected]
    .sort((left, right) => left - right)
    .flatMap((index) => turns[index]!.entries);
}

export function isMemoryToolName(name: string): boolean {
  return name === 'memory_remember' || name === 'memory_extract';
}

function toolCallIntervals(
  entries: readonly MemoryExtractionEventEntry[],
): ReadonlyArray<{ callOrdinal: number; responseOrdinal?: number; terminalOrdinal?: number }> {
  const responses = new Map<string, Array<{ ordinal: number; name: string }>>();
  const terminals = new Map<string, number[]>();
  for (const { ordinal, event } of entries) {
    if (event.partial) continue;
    if (isTerminalRuntimeEvent(event)) {
      const ordinals = terminals.get(event.invocationId) ?? [];
      ordinals.push(ordinal);
      terminals.set(event.invocationId, ordinals);
    }
    if (event.content?.kind === 'function_response') {
      const key = toolExchangeKey(event, event.content.id);
      const matches = responses.get(key) ?? [];
      matches.push({ ordinal, name: event.content.name });
      responses.set(key, matches);
    }
  }
  return entries.flatMap(({ ordinal, event }) => {
    if (
      event.partial ||
      event.content?.kind !== 'function_call' ||
      isMemoryToolName(event.content.name)
    ) {
      return [];
    }
    const callName = event.content.name;
    const responseOrdinal = responses
      .get(toolExchangeKey(event, event.content.id))
      ?.find((candidate) => candidate.ordinal > ordinal && candidate.name === callName)?.ordinal;
    const terminalOrdinal = terminals
      .get(event.invocationId)
      ?.find((candidate) => candidate >= ordinal);
    return [
      {
        callOrdinal: ordinal,
        ...(responseOrdinal ? { responseOrdinal } : {}),
        ...(terminalOrdinal ? { terminalOrdinal } : {}),
      },
    ];
  });
}

function toolUnsafeRanges(
  intervals: ReadonlyArray<{
    callOrdinal: number;
    responseOrdinal?: number;
    terminalOrdinal?: number;
  }>,
  boundaryOrdinal: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const closedAt = interval.responseOrdinal ?? interval.terminalOrdinal;
    const end = Math.min(boundaryOrdinal, (closedAt ?? boundaryOrdinal + 1) - 1);
    if (end < interval.callOrdinal) continue;
    const previous = ranges.at(-1);
    if (previous && interval.callOrdinal <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start: interval.callOrdinal, end });
    }
  }
  return ranges;
}

function boundedEvidenceText(value: string, terms: readonly string[] | undefined): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_EVIDENCE_TEXT_CHARS) return value;
  const normalizedTerms = terms
    ?.map((term) => normalizeEvidenceText(term).toLowerCase())
    .filter(Boolean);
  const lower = value.toLowerCase();
  const hit = normalizedTerms
    ?.map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (hit === undefined) return codePoints.slice(0, MAX_EVIDENCE_TEXT_CHARS).join('');
  const before = Math.floor(MAX_EVIDENCE_TEXT_CHARS / 3);
  const start = Math.max(0, Array.from(value.slice(0, hit)).length - before);
  return codePoints.slice(start, start + MAX_EVIDENCE_TEXT_CHARS).join('');
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function minuteTimestamp(value: number): number {
  return Math.floor(value / 60_000) * 60_000;
}

function boundedJson(value: unknown, terms: readonly string[] | undefined): string {
  return boundedEvidenceText(safeJson(value) || '[empty]', terms);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

function isEmptyToolResult(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function historyRole(event: RuntimeEvent): 'user' | 'model' | 'tool' {
  return event.role === 'user' ? 'user' : event.role === 'tool' ? 'tool' : 'model';
}

function isMemoryEvent(event: RuntimeEvent): boolean {
  return (
    (event.content?.kind === 'function_call' || event.content?.kind === 'function_response') &&
    isMemoryToolName(event.content.name)
  );
}

function sliceCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function toolExchangeKey(event: RuntimeEvent, toolCallId: string): string {
  return `${event.invocationId}\0${toolCallId}`;
}
