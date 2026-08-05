import { createHash } from 'node:crypto';
import type {
  CommitMemoryExtractionRequest,
  MemoryExtractionCursor,
  MemoryExtractionReceipt,
  MemoryItemWrite,
} from '@maka/core/long-term-memory';
import type { SessionHeader } from '@maka/core/session';
import { z } from 'zod';
import {
  fitMemoryExtractionEvidence,
  isMemoryToolName,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  searchSameSessionMemoryHistory,
  type MemoryExtractionEventEntry,
} from './memory-extraction-evidence.js';
import {
  admitMemoryProposalItem,
  buildFirstMemoryProposalPrompt,
  buildLocalizedMemoryProposalPrompt,
  deterministicMemoryPolicyRejection,
  minuteTimestamp,
  parseLocalizedMemoryProposal,
  parseMemoryProposal,
  type AdmittedProposalFields,
} from './memory-extraction-proposal.js';
import type { ModelMessage, ModelToolSet } from './model-protocol.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember';
export const MEMORY_EXTRACT_TOOL_NAME = 'memory_extract';
export type MemoryExtractionTrigger = 'remember' | 'extract';
export type MemoryExtractionGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'disabled' | 'incognito' | 'unavailable' };

/** Exact Provider prefix frozen by AiSdkBackend at the source Tool/terminal boundary. */
export interface MemoryExtractionSourceSnapshot {
  readonly trigger: MemoryExtractionTrigger;
  readonly sourceHeader: Pick<SessionHeader, 'llmConnectionSlug' | 'model' | 'thinkingLevel'>;
  readonly sourceSystemPrompt?: string;
  readonly sourceMessages: readonly ModelMessage[];
  /** Exact RuntimeEvent-to-message positions carried beside the frozen Provider prefix. */
  readonly sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>;
  readonly sourceTools: ModelToolSet;
  readonly sourceActiveTools: readonly string[];
  readonly sourceProviderOptions?: Record<string, unknown>;
  readonly sourceMaxOutputTokens?: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly workspaceKey: string;
  /** Present only for memory_remember; identifies the call excluded from evidence. */
  readonly toolCallId?: string;
  /** Present only for post-terminal memory_extract. */
  readonly terminalEventId?: string;
}

interface RememberedMemoryItem {
  readonly itemId: string;
  readonly content: string;
}

export type MemoryRememberResult =
  | { readonly status: 'remembered'; readonly requestedItems: readonly RememberedMemoryItem[] }
  | { readonly status: 'not_applicable'; readonly requestedItems: readonly [] }
  | { readonly status: 'unavailable'; readonly requestedItems: readonly [] };

export interface MemoryExtractionSourceCapabilities {
  readonly gate: () => Promise<MemoryExtractionGate>;
  readonly remember: (snapshot: MemoryExtractionSourceSnapshot) => Promise<MemoryRememberResult>;
  readonly extract: (snapshot: MemoryExtractionSourceSnapshot) => void;
}

export interface MemoryExtractionEnginePorts {
  readonly readGate: (sessionId: string) => Promise<MemoryExtractionGate>;
  readonly readSessionEvents: (sessionId: string) => Promise<readonly MemoryExtractionEventEntry[]>;
  readonly readCursor: (sessionId: string) => Promise<MemoryExtractionCursor | undefined>;
  readonly readReceipt: (operationId: string) => Promise<MemoryExtractionReceipt | undefined>;
  readonly generate: (input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly prompt: string;
    readonly stage: 'proposal' | 'localized';
    readonly abortSignal: AbortSignal;
  }) => Promise<string>;
  readonly commit: (request: CommitMemoryExtractionRequest) => Promise<{
    readonly receipt: MemoryExtractionReceipt;
  }>;
  readonly now?: () => number;
}

export function buildMemoryExtractionTriggerTools(input: {
  readonly capabilities: MemoryExtractionSourceCapabilities;
  readonly snapshot: (
    trigger: MemoryExtractionTrigger,
    context: MakaToolContext,
  ) => MemoryExtractionSourceSnapshot | undefined;
  readonly markExtractRequested: (context: MakaToolContext) => void;
}): readonly MakaTool[] {
  const noArguments = z.object({}).strict();
  return [
    {
      name: MEMORY_REMEMBER_TOOL_NAME,
      description:
        'Use only when the user explicitly asks you to remember long-term information. It stores the requested memory and returns exactly what was saved.',
      parameters: noArguments,
      executionSemantics: 'exclusive_step',
      recoveryMode: 'idempotent',
      impl: async (_args: Record<string, never>, context: MakaToolContext) => {
        const gate = await input.capabilities.gate();
        if (!gate.allowed) return { status: 'unavailable', requestedItems: [] };
        const snapshot = input.snapshot('remember', context);
        if (!snapshot) return { status: 'unavailable', requestedItems: [] };
        return input.capabilities.remember(snapshot);
      },
    },
    {
      name: MEMORY_EXTRACT_TOOL_NAME,
      description:
        'Use when the conversation contains durable long-term information worth preserving and the user did not explicitly ask to remember it. The extraction runs after this turn.',
      parameters: noArguments,
      recoveryMode: 'idempotent',
      impl: async (_args: Record<string, never>, context: MakaToolContext) => {
        const gate = await input.capabilities.gate();
        if (!gate.allowed) return { status: 'unavailable' };
        input.markExtractRequested(context);
        return { status: 'accepted' };
      },
    },
  ];
}

/** Runtime-owned bounded state machine. Host supplies authority and lifecycle ports only. */
export class MemoryExtractionEngine {
  constructor(private readonly ports: MemoryExtractionEnginePorts) {}

  async execute(snapshot: MemoryExtractionSourceSnapshot): Promise<MemoryRememberResult> {
    const operationId = memoryExtractionOperationId(snapshot);
    if (!operationId || !(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();

    const existing = await this.ports.readReceipt(operationId);
    if (existing) return rememberResultFromReceipt(snapshot.trigger, existing);

    if (!(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();
    const entries = await this.ports.readSessionEvents(snapshot.sessionId);
    const boundary = findExtractionBoundary(entries, snapshot);
    if (!boundary || !(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();

    const cursor = await this.ports.readCursor(snapshot.sessionId);
    const expectedCursorOrdinal = cursor?.processedOrdinal ?? 0;
    if (expectedCursorOrdinal >= boundary.ordinal) {
      return snapshot.trigger === 'remember'
        ? { status: 'not_applicable', requestedItems: [] }
        : unavailableMemoryResult();
    }
    const pendingEntries = entries.filter(
      ({ ordinal }) => ordinal > expectedCursorOrdinal && ordinal <= boundary.ordinal,
    );

    const priorityEvidence =
      snapshot.trigger === 'remember'
        ? projectMemoryExtractionEvidence(
            entries
              .filter(
                ({ ordinal, event }) =>
                  ordinal <= boundary.ordinal &&
                  event.runId === snapshot.runId &&
                  event.turnId === snapshot.turnId,
              )
              .map(({ event }) => event),
          )
        : [];
    const coverage = planMemoryCoverage({
      pendingEntries,
      allEntries: entries,
      boundaryOrdinal: boundary.ordinal,
      priorityEvidence,
      sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
    });
    if (!coverage || coverage.entries.length === 0) return unavailableMemoryResult();

    if (!(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();
    const firstRaw = await this.callModel(
      snapshot,
      buildFirstMemoryProposalPrompt({
        trigger: snapshot.trigger,
        now: this.now(),
        evidence: coverage.evidence,
        sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
      }),
      'proposal',
    );
    const first = parseMemoryProposal(firstRaw);
    if (!first) return unavailableMemoryResult();
    if (
      snapshot.trigger === 'extract' &&
      (first.status !== 'complete' ||
        first.requestedStatus !== 'not_applicable' ||
        first.requestedItems.length > 0)
    ) {
      return unavailableMemoryResult();
    }

    let requestedItems = first.requestedItems;
    let requestedStatus = first.requestedStatus;
    let requestedAdmissionEvidence = coverage.evidence;
    if (first.status === 'search_required') {
      if (snapshot.trigger !== 'remember') {
        return unavailableMemoryResult();
      }
      if (!(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();
      const localizedEntries = searchSameSessionMemoryHistory(
        entries,
        boundary.ordinal,
        first.search,
      );
      if (localizedEntries.length === 0) return unavailableMemoryResult();
      const localizedEvidence = fitMemoryExtractionEvidence(
        projectMemoryExtractionEvidence(
          localizedEntries.map(({ event }) => event),
          { snippetTerms: first.search.terms },
        ),
        undefined,
        snapshot.sourceEventMessagePositions,
      );
      if (!localizedEvidence || !(await this.allowed(snapshot.sessionId))) {
        return unavailableMemoryResult();
      }
      const localizedRaw = await this.callModel(
        snapshot,
        buildLocalizedMemoryProposalPrompt({
          now: this.now(),
          evidence: localizedEvidence,
          sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
        }),
        'localized',
      );
      const localized = parseLocalizedMemoryProposal(localizedRaw);
      if (!localized || localized.status === 'cannot_resolve') return unavailableMemoryResult();
      requestedItems = localized.requestedItems;
      requestedStatus = localized.status;
      requestedAdmissionEvidence = localizedEvidence;
    } else if (first.status === 'cannot_resolve') {
      return unavailableMemoryResult();
    }

    if (requestedStatus === 'unresolved') {
      return unavailableMemoryResult();
    }
    const requestedEvidenceByRef = new Map(
      requestedAdmissionEvidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEvidenceByRef = new Map(
      coverage.evidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEventIds = new Set(coverage.entries.map(({ event }) => event.id));
    const writes: MemoryItemWrite[] = [];
    const requestedItemIndexes: number[] = [];
    for (const [requested, proposals] of [
      [true, requestedItems],
      [false, first.incidentalItems],
    ] as const) {
      for (const proposal of proposals) {
        if (deterministicMemoryPolicyRejection(proposal)) continue;
        const admitted = admitMemoryProposalItem(
          proposal,
          requested ? requestedEvidenceByRef : coverageEvidenceByRef,
        );
        if (!admitted) continue;
        if (!requested && admitted.citedEvents.some((event) => !coverageEventIds.has(event.id))) {
          continue;
        }
        if (requested) requestedItemIndexes.push(writes.length);
        writes.push(memoryItemWrite(snapshot, admitted, requested));
      }
    }

    if (!(await this.allowed(snapshot.sessionId))) return unavailableMemoryResult();
    const committed = await this.ports.commit({
      operationId,
      sessionId: snapshot.sessionId,
      expectedCursorOrdinal,
      nextCursorOrdinal: coverage.entries.at(-1)!.ordinal,
      items: writes,
      requestedItemIndexes,
      trigger: snapshot.trigger,
    });
    return rememberResultFromReceipt(snapshot.trigger, committed.receipt);
  }

  private async callModel(
    snapshot: MemoryExtractionSourceSnapshot,
    prompt: string,
    stage: 'proposal' | 'localized',
  ): Promise<string> {
    if (!(await this.allowed(snapshot.sessionId))) throw new Error('Memory extraction disabled');
    return this.ports.generate({
      snapshot,
      prompt,
      stage,
      abortSignal: AbortSignal.timeout(60_000),
    });
  }

  private async allowed(sessionId: string): Promise<boolean> {
    return (await this.ports.readGate(sessionId)).allowed;
  }

  private now(): number {
    return (this.ports.now ?? Date.now)();
  }
}

function memoryExtractionOperationId(snapshot: MemoryExtractionSourceSnapshot): string | undefined {
  const stableBoundary =
    snapshot.trigger === 'remember' ? snapshot.toolCallId : snapshot.terminalEventId;
  if (!stableBoundary) return undefined;
  return `memory_${createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: snapshot.sessionId,
        runId: snapshot.runId,
        turnId: snapshot.turnId,
        trigger: snapshot.trigger,
        stableBoundary,
      }),
    )
    .digest('hex')}`;
}

function findExtractionBoundary(
  entries: readonly MemoryExtractionEventEntry[],
  snapshot: MemoryExtractionSourceSnapshot,
): MemoryExtractionEventEntry | undefined {
  if (snapshot.trigger === 'extract') {
    return entries.find(
      ({ event }) =>
        event.id === snapshot.terminalEventId &&
        event.runId === snapshot.runId &&
        event.turnId === snapshot.turnId,
    );
  }
  if (!snapshot.toolCallId) return undefined;
  const callIndex = entries.findIndex(
    ({ event }) =>
      event.runId === snapshot.runId &&
      event.turnId === snapshot.turnId &&
      event.content?.kind === 'function_call' &&
      event.content.id === snapshot.toolCallId &&
      event.content.name === MEMORY_REMEMBER_TOOL_NAME,
  );
  if (callIndex < 1) return undefined;
  for (let index = callIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.event.partial && !isMemoryEvent(entry.event)) return entry;
  }
  return undefined;
}

function isMemoryEvent(event: MemoryExtractionEventEntry['event']): boolean {
  return (
    (event.content?.kind === 'function_call' || event.content?.kind === 'function_response') &&
    isMemoryToolName(event.content.name)
  );
}

function memoryItemWrite(
  snapshot: MemoryExtractionSourceSnapshot,
  fields: AdmittedProposalFields,
  requested: boolean,
): MemoryItemWrite {
  const sources = new Map<string, MemoryItemWrite['sources'][number]>();
  for (const event of fields.citedEvents) {
    sources.set(event.id, {
      sessionId: event.sessionId,
      runId: event.runId,
      turnId: event.turnId,
      eventId: event.id,
    });
  }
  return {
    content: fields.content,
    kind: fields.kind,
    statementType: fields.statementType,
    temporalType: fields.temporalType,
    scopeType: fields.scopeType,
    scopeKey: fields.scopeType === 'workspace' ? snapshot.workspaceKey : null,
    eventStartedAt: fields.eventStartedAt,
    eventEndedAt: fields.eventEndedAt,
    observedAt: minuteTimestamp(Math.max(...fields.citedEvents.map((event) => event.ts))),
    origin: requested ? 'user_requested' : 'agent_extracted',
    keys: fields.keys.map(({ key, keyType }) => ({
      key,
      keyType,
      keyOrigin: requested ? 'user' : 'llm',
    })),
    sources: [...sources.values()],
  };
}

function rememberResultFromReceipt(
  trigger: MemoryExtractionTrigger,
  receipt: MemoryExtractionReceipt,
): MemoryRememberResult {
  if (trigger === 'extract') return unavailableMemoryResult();
  if (receipt.status === 'remembered' && receipt.requestedItems.length > 0) {
    return { status: 'remembered', requestedItems: receipt.requestedItems };
  }
  return { status: 'not_applicable', requestedItems: [] };
}

function unavailableMemoryResult(): MemoryRememberResult {
  return { status: 'unavailable', requestedItems: [] };
}
