import { createHash } from 'node:crypto';
import type {
  CommitMemoryExtractionRequest,
  MemoryExtractionCursor,
  MemoryExtractionFailureClass,
  MemoryExtractionReceipt,
  MemoryItemWrite,
  PendingMemoryExtractionFailure,
  SettleMemoryExtractionFailureRequest,
  SettleMemoryExtractionFailureResult,
} from '@maka/core/long-term-memory';
import { redactSecrets } from '@maka/core/redaction';
import type { SessionHeader } from '@maka/core/session';
import { z } from 'zod';
import {
  fitMemoryExtractionEvidence,
  bindProviderVisibleEvidence,
  isMemoryToolName,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  searchSameSessionMemoryHistory,
  type MemoryExtractionEventEntry,
  type MemoryCoveragePlan,
} from './memory-extraction-evidence.js';
import {
  admitMemoryProposalItemDetailed,
  buildFirstMemoryProposalPrompt,
  buildLocalizedMemoryProposalPrompt,
  buildMemoryCanonicalizationPrompt,
  deterministicMemoryPolicyRejection,
  minuteTimestamp,
  parseMemoryCanonicalization,
  parseLocalizedMemoryProposal,
  parseMemoryProposal,
  type AdmittedProposalFields,
  type MemoryProposalItem,
} from './memory-extraction-proposal.js';
import { isHistoryCompactContentEvent } from './history-compact.js';
import {
  matchHistoryCompactCheckpointPrefix,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import {
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  formatTextWithInlineRefs,
  type RuntimeEventModelReplayItem,
} from './model-history.js';
import type { ModelMessage, ModelToolSet } from './model-protocol.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember';
export const MEMORY_EXTRACT_TOOL_NAME = 'memory_extract';
export type MemoryExtractionTrigger = 'remember' | 'extract' | 'compaction';
export type MemoryExtractionGate =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'disabled' | 'incognito' | 'ineligible' | 'unavailable';
    };

/** Frozen extraction request. Compaction may defer durable-prefix materialization to its lane. */
export interface MemoryExtractionSourceSnapshot {
  readonly trigger: MemoryExtractionTrigger;
  readonly sourceHeader: Pick<SessionHeader, 'llmConnectionSlug' | 'model' | 'thinkingLevel'>;
  readonly sourceSystemPrompt?: string;
  readonly sourceMessages: readonly ModelMessage[];
  /** Compaction-only recipe: rebuild messages from its durable checkpoint boundary. */
  readonly rebuildSourceContextFromCompactionCheckpoint?: true;
  /** RuntimeEvent-to-message positions in the frozen provider prefix. */
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
  /** Present only for automatic Compaction extraction. */
  readonly compactionCheckpointId?: string;
  /** Exact durable RuntimeEvent boundary captured by the Compaction checkpoint. */
  readonly compactionBoundaryEventId?: string;
}

export interface MemoryCompactionSourceContext {
  readonly messages: readonly ModelMessage[];
  readonly eventMessagePositions?: Readonly<Record<string, readonly number[]>>;
}

interface RememberedMemoryItem {
  readonly itemId: string;
  readonly content: string;
}

export type MemoryRememberResult =
  | { readonly status: 'remembered'; readonly requestedItems: readonly RememberedMemoryItem[] }
  | {
      readonly status: 'not_applicable';
      readonly requestedItems: readonly [];
      readonly reason?: 'sensitive_information';
    }
  | {
      readonly status: 'unavailable';
      readonly requestedItems: readonly [];
      readonly reason?: 'provider_unsupported';
    };

export interface MemoryExtractionSourceCapabilities {
  readonly gate: () => Promise<MemoryExtractionGate>;
  readonly remember: (snapshot: MemoryExtractionSourceSnapshot) => Promise<MemoryRememberResult>;
  readonly extract: (snapshot: MemoryExtractionSourceSnapshot) => void;
}

export interface MemoryExtractionEnginePorts {
  readonly readGate: (sessionId: string) => Promise<MemoryExtractionGate>;
  readonly readSessionEvents: (sessionId: string) => Promise<readonly MemoryExtractionEventEntry[]>;
  readonly readCursor: (sessionId: string) => Promise<MemoryExtractionCursor | undefined>;
  readonly initializeCursor: (
    sessionId: string,
    processedOrdinal: number,
  ) => Promise<MemoryExtractionCursor>;
  readonly readPendingFailure: (
    sessionId: string,
  ) => Promise<PendingMemoryExtractionFailure | undefined>;
  readonly readLatestCompactionCheckpoint: (
    sessionId: string,
  ) => Promise<HistoryCompactCheckpoint | undefined>;
  readonly readCompactionCheckpoints: (
    sessionId: string,
  ) => Promise<readonly HistoryCompactCheckpoint[]>;
  readonly readReceipt: (operationId: string) => Promise<MemoryExtractionReceipt | undefined>;
  readonly generate: (input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly prompt: string;
    readonly stage: 'proposal' | 'localized' | 'canonicalize';
    readonly abortSignal: AbortSignal;
  }) => Promise<
    | { readonly ok: true; readonly text: string }
    | {
        readonly ok: false;
        readonly errorClass:
          | 'aborted'
          | 'timeout'
          | 'configuration'
          | 'provider'
          | 'persistence'
          | 'unknown';
      }
  >;
  readonly commit: (request: CommitMemoryExtractionRequest) => Promise<{
    readonly receipt: MemoryExtractionReceipt;
  }>;
  readonly settleFailure: (
    request: SettleMemoryExtractionFailureRequest,
  ) => Promise<SettleMemoryExtractionFailureResult>;
  readonly now?: () => number;
}

/**
 * Build the attachment-free normalized history used by automatic extraction and crash recovery.
 * RuntimeEvents remain the evidence authority; this projection is context only.
 */
export function buildMemoryCompactionSourceContext(
  events: readonly MemoryExtractionEventEntry['event'][],
  boundaryEventId: string,
): MemoryCompactionSourceContext | undefined {
  const boundaryIndex = events.findIndex((event) => event.id === boundaryEventId);
  if (boundaryIndex < 0) return undefined;
  const plan = buildRuntimeEventModelReplayPlan(events.slice(0, boundaryIndex + 1));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const messages: ModelMessage[] = [];
  const positions: Record<string, number[]> = {};
  const push = (eventIds: readonly string[], message: ModelMessage): void => {
    const index = messages.length;
    messages.push(message);
    for (const eventId of eventIds) (positions[eventId] ??= []).push(index);
  };
  type TextItem = Extract<RuntimeEventModelReplayItem, { kind: 'text' }>;
  type ToolCallItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
  type ToolResultItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_result' }>;
  const textWithoutAttachments = (item: TextItem): string | undefined => {
    const event = eventsById.get(item.eventId);
    if (!event || event.content?.kind !== 'text') return undefined;
    const text = formatTextWithInlineRefs(event.content.text, {
      ...(event.content.quotes ? { quotes: event.content.quotes } : {}),
    });
    return event.content.steering === true && item.role === 'user'
      ? buildSteeringEnvelope(text)
      : text;
  };
  const results = new Map<string, ToolResultItem>();
  for (const item of plan.items) {
    if (item.kind === 'tool_result') results.set(item.toolCallId, item);
  }
  let bufferedCalls: ToolCallItem[] = [];
  const textByStep = new Map<string, TextItem>();
  const emitStep = (text: TextItem | undefined, calls: readonly ToolCallItem[]): void => {
    const content: Extract<ModelMessage, { role: 'assistant' }>['content'] = [];
    const eventIds = [...(text ? [text.eventId] : []), ...calls.map((call) => call.eventId)];
    if (text) {
      const rendered = textWithoutAttachments(text);
      if (rendered === undefined) return;
      if (rendered.length > 0) content.push({ type: 'text', text: rendered });
    }
    for (const call of calls) {
      content.push({
        type: 'text',
        text: portableMemoryToolCallText(call),
      });
      const result = results.get(call.toolCallId);
      if (!result) continue;
      results.delete(call.toolCallId);
      eventIds.push(result.eventId);
      content.push({
        type: 'text',
        text: portableMemoryToolResultText(result),
      });
    }
    if (content.length > 0) push(eventIds, { role: 'assistant', content });
  };
  const emitGroupedCalls = (calls: readonly ToolCallItem[]): void => {
    let group: ToolCallItem[] = [];
    const emitGroup = (): void => {
      if (group.length === 0) return;
      const stepId = group[0]!.stepId;
      const text = stepId ? textByStep.get(stepId) : undefined;
      if (stepId) textByStep.delete(stepId);
      emitStep(text, group);
      group = [];
    };
    for (const call of calls) {
      if (group.length > 0 && group[0]!.stepId !== call.stepId) emitGroup();
      group.push(call);
    }
    emitGroup();
  };
  const flushPendingSteps = (): void => {
    if (bufferedCalls.length > 0) {
      const calls = bufferedCalls;
      bufferedCalls = [];
      emitGroupedCalls(calls);
    }
    for (const [stepId, text] of textByStep) {
      textByStep.delete(stepId);
      emitStep(text, []);
    }
  };
  for (const item of plan.items) {
    if (item.kind === 'thinking' || item.kind === 'tool_result') continue;
    if (item.kind === 'tool_call') {
      bufferedCalls.push(item);
      continue;
    }
    if (item.role === 'system') continue;
    if (item.role !== 'assistant') {
      flushPendingSteps();
      const rendered = textWithoutAttachments(item);
      if (rendered === undefined) return undefined;
      push([item.eventId], { role: item.role, content: [{ type: 'text', text: rendered }] });
      continue;
    }
    if (item.stepId) {
      const calls = bufferedCalls.filter((call) => call.stepId === item.stepId);
      const otherCalls = bufferedCalls.filter((call) => call.stepId !== item.stepId);
      bufferedCalls = [];
      if (otherCalls.length > 0) emitGroupedCalls(otherCalls);
      if (calls.length > 0) emitStep(item, calls);
      else textByStep.set(item.stepId, item);
      continue;
    }
    flushPendingSteps();
    emitStep(item, []);
  }
  flushPendingSteps();
  // Thinking and all attachment refs/bytes are intentionally outside PR 2-B context.
  if (messages.length === 0) return undefined;
  return {
    messages: structuredClone(messages),
    ...(Object.keys(positions).length > 0 ? { eventMessagePositions: positions } : {}),
  };
}

function portableMemoryToolCallText(
  call: Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>,
): string {
  return `<tool_call name=${JSON.stringify(call.toolName)}>${portableJson(call.input)}</tool_call>`;
}

function portableMemoryToolResultText(
  result: Extract<RuntimeEventModelReplayItem, { kind: 'tool_result' }>,
): string {
  return `<tool_result name=${JSON.stringify(result.toolName)} error=${String(
    result.isError,
  )}>${portableJson(stripMemoryAttachmentPayloads(result.output))}</tool_result>`;
}

function portableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stripMemoryAttachmentPayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMemoryAttachmentPayloads);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const mediaKind = typeof record.kind === 'string' ? record.kind : record.type;
  if (
    typeof mediaKind === 'string' &&
    ['attachment', 'audio', 'file', 'image', 'pdf', 'video'].includes(mediaKind.toLowerCase()) &&
    ('ref' in record || 'data' in record || 'bytes' in record || 'mimeType' in record)
  ) {
    return '[attachment result omitted from Memory extraction context]';
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, stripMemoryAttachmentPayloads(child)]),
  );
}

const MAX_MEMORY_EXTRACTION_MODEL_CALLS = 3;

type CoverageProcessingResult =
  | {
      readonly kind: 'committed';
      readonly receipt: MemoryExtractionReceipt;
      readonly nextCursorOrdinal: number;
    }
  | { readonly kind: 'counted_failure'; readonly failureClass: MemoryExtractionFailureClass }
  | { readonly kind: 'blocked' };

interface MemoryModelCallBudget {
  remaining: number;
}

export function buildMemoryExtractionTriggerTools(input: {
  readonly capabilities: MemoryExtractionSourceCapabilities;
  readonly snapshot: (
    trigger: MemoryExtractionTrigger,
    context: MakaToolContext,
  ) => MemoryExtractionSourceSnapshot | undefined;
  readonly markExtractRequested: (context: MakaToolContext) => void;
  readonly unsupportedReason?: 'provider_unsupported';
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
        if (input.unsupportedReason) {
          return {
            status: 'unavailable',
            reason: input.unsupportedReason,
            requestedItems: [],
          };
        }
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
        if (input.unsupportedReason) {
          return { status: 'unavailable', reason: input.unsupportedReason };
        }
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
    if (!validSourceContextContract(snapshot)) return unavailableMemoryResult();
    const operationId = memoryExtractionOperationId(snapshot);
    if (!operationId) return unavailableMemoryResult();
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }

    const existing = await this.ports.readReceipt(operationId);
    if (existing) return rememberResultFromReceipt(snapshot.trigger, existing);

    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }
    const entries = await this.ports.readSessionEvents(snapshot.sessionId);
    const compactionCheckpoints = await this.ports.readCompactionCheckpoints(snapshot.sessionId);
    const currentCompactionCheckpoint =
      snapshot.trigger === 'compaction'
        ? compactionCheckpoints.find(
            (checkpoint) => checkpoint.checkpointId === snapshot.compactionCheckpointId,
          )
        : undefined;
    if (
      snapshot.trigger === 'compaction' &&
      (!currentCompactionCheckpoint ||
        !compactionCheckpointMatchesSnapshot([currentCompactionCheckpoint], snapshot))
    ) {
      return unavailableMemoryResult();
    }
    const boundary = currentCompactionCheckpoint
      ? compactionBoundaryEntry(entries, currentCompactionCheckpoint)
      : findExtractionBoundary(entries, snapshot);
    if (!boundary) return unavailableMemoryResult();
    if (currentCompactionCheckpoint?.memoryExtractionBoundary?.disposition === 'policy_denied') {
      await this.settlePolicyDeniedCheckpoint(snapshot, currentCompactionCheckpoint, entries);
      return unavailableMemoryResult();
    }
    const currentSnapshot = currentCompactionCheckpoint
      ? rebuildCompactionSnapshot(snapshot, currentCompactionCheckpoint, entries)
      : snapshot;
    if (!currentSnapshot) return unavailableMemoryResult();
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }

    let cursor = await this.ports.readCursor(snapshot.sessionId);
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }
    const pendingFailure = await this.ports.readPendingFailure(snapshot.sessionId);
    if (!cursor && !pendingFailure) {
      if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
        return unavailableMemoryResult();
      }
      const checkpoint = await this.ports.readLatestCompactionCheckpoint(snapshot.sessionId);
      const hasRecoverableCompaction = compactionCheckpoints.some((candidate) => {
        const candidateBoundary = compactionBoundaryEntry(entries, candidate);
        return candidateBoundary !== undefined && candidateBoundary.ordinal <= boundary.ordinal;
      });
      const bootstrapOrdinal =
        checkpoint && !hasRecoverableCompaction
          ? validCompactionBootstrapOrdinal(entries, checkpoint)
          : undefined;
      if (bootstrapOrdinal && bootstrapOrdinal <= boundary.ordinal) {
        cursor = await this.ports.initializeCursor(snapshot.sessionId, bootstrapOrdinal);
      }
    }

    let expectedCursorOrdinal = cursor?.processedOrdinal ?? 0;
    if (pendingFailure?.firstOperationId === operationId) return unavailableMemoryResult();
    if (
      pendingFailure &&
      (pendingFailure.fromOrdinal !== expectedCursorOrdinal + 1 ||
        pendingFailure.throughOrdinal > boundary.ordinal)
    ) {
      return unavailableMemoryResult();
    }
    if (pendingFailure) {
      const pendingCheckpoint = pendingFailure.compactionCheckpointId
        ? compactionCheckpoints.find(
            (checkpoint) => checkpoint.checkpointId === pendingFailure.compactionCheckpointId,
          )
        : undefined;
      const pendingBoundary = pendingCheckpoint
        ? compactionBoundaryEntry(entries, pendingCheckpoint)
        : undefined;
      if (pendingCheckpoint && pendingBoundary?.ordinal !== pendingFailure.throughOrdinal) {
        return unavailableMemoryResult();
      }
      const retrySnapshot = pendingCheckpoint
        ? rebuildCompactionSnapshot(currentSnapshot, pendingCheckpoint, entries)
        : pendingFailure.compactionCheckpointId
          ? undefined
          : currentSnapshot;
      if (!retrySnapshot) return unavailableMemoryResult();
      const retryOperationId = pendingRetryOperationId(operationId, pendingFailure);
      const retry = await this.processRange({
        snapshot: retrySnapshot,
        trigger: pendingFailure.firstTrigger,
        operationId: retryOperationId,
        expectedCursorOrdinal,
        targetBoundaryOrdinal: pendingFailure.throughOrdinal,
        expectedCoverageHash: pendingFailure.coverageHash,
        entries,
        prioritizeCurrentTurn: false,
      });
      if (retry.kind === 'blocked') {
        await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
        return unavailableMemoryResult();
      }
      if (retry.kind === 'committed') {
        expectedCursorOrdinal = retry.nextCursorOrdinal;
      } else {
        const settled = await this.settleCountedFailure({
          snapshot: retrySnapshot,
          trigger: pendingFailure.firstTrigger,
          operationId: retryOperationId,
          expectedCursorOrdinal,
          throughOrdinal: pendingFailure.throughOrdinal,
          coverageHash: pendingFailure.coverageHash,
          failureClass: retry.failureClass,
        });
        if (!settled) {
          await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
          return unavailableMemoryResult();
        }
        if (settled.status !== 'discarded') return unavailableMemoryResult();
        expectedCursorOrdinal = settled.cursor.processedOrdinal;
      }
    } else {
      for (;;) {
        const recoveredCheckpoint = earliestUnprocessedCompactionCheckpoint(
          compactionCheckpoints,
          entries,
          expectedCursorOrdinal,
          boundary.ordinal,
          snapshot.compactionCheckpointId,
        );
        if (!recoveredCheckpoint) break;
        if (recoveredCheckpoint.memoryExtractionBoundary?.disposition === 'policy_denied') {
          const nextCursorOrdinal = await this.settlePolicyDeniedCheckpoint(
            snapshot,
            recoveredCheckpoint,
            entries,
          );
          if (nextCursorOrdinal === undefined) return unavailableMemoryResult();
          expectedCursorOrdinal = nextCursorOrdinal;
        } else {
          const recoveredSnapshot = rebuildCompactionSnapshot(
            currentSnapshot,
            recoveredCheckpoint,
            entries,
          );
          const recoveredBoundary = compactionBoundaryEntry(entries, recoveredCheckpoint);
          const recoveredOperationId = recoveredSnapshot
            ? memoryExtractionOperationId(recoveredSnapshot)
            : undefined;
          if (!recoveredSnapshot || !recoveredBoundary || !recoveredOperationId) {
            return unavailableMemoryResult();
          }
          const recovered = await this.processRange({
            snapshot: recoveredSnapshot,
            trigger: 'compaction',
            operationId: recoveredOperationId,
            expectedCursorOrdinal,
            targetBoundaryOrdinal: recoveredBoundary.ordinal,
            entries,
            prioritizeCurrentTurn: false,
          });
          if (recovered.kind === 'blocked') {
            await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
            return unavailableMemoryResult();
          }
          if (recovered.kind === 'counted_failure') {
            const settled = await this.settleCountedFailure({
              snapshot: recoveredSnapshot,
              trigger: 'compaction',
              operationId: recoveredOperationId,
              expectedCursorOrdinal,
              throughOrdinal: recoveredBoundary.ordinal,
              coverageHash: memoryCoverageHash(
                entries.filter(
                  ({ ordinal }) =>
                    ordinal > expectedCursorOrdinal && ordinal <= recoveredBoundary.ordinal,
                ),
              ),
              failureClass: recovered.failureClass,
            });
            if (!settled) {
              await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
            }
            return unavailableMemoryResult();
          }
          expectedCursorOrdinal = recovered.nextCursorOrdinal;
        }
      }
    }

    if (expectedCursorOrdinal >= boundary.ordinal) {
      return snapshot.trigger === 'remember'
        ? { status: 'not_applicable', requestedItems: [] }
        : unavailableMemoryResult();
    }

    const processed = await this.processRange({
      snapshot: currentSnapshot,
      trigger: snapshot.trigger,
      operationId,
      expectedCursorOrdinal,
      targetBoundaryOrdinal: boundary.ordinal,
      entries,
      prioritizeCurrentTurn: snapshot.trigger === 'remember',
    });
    if (processed.kind === 'committed') {
      return rememberResultFromReceipt(snapshot.trigger, processed.receipt);
    }
    if (processed.kind === 'counted_failure') {
      const settled = await this.settleCountedFailure({
        snapshot: currentSnapshot,
        trigger: snapshot.trigger,
        operationId,
        expectedCursorOrdinal,
        throughOrdinal: boundary.ordinal,
        coverageHash: memoryCoverageHash(
          entries.filter(
            ({ ordinal }) => ordinal > expectedCursorOrdinal && ordinal <= boundary.ordinal,
          ),
        ),
        failureClass: processed.failureClass,
      });
      if (!settled) {
        await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
      }
    } else if (processed.kind === 'blocked') {
      await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
    }
    return unavailableMemoryResult();
  }

  private async processRange(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly targetBoundaryOrdinal: number;
    readonly expectedCoverageHash?: string;
    readonly entries: readonly MemoryExtractionEventEntry[];
    readonly prioritizeCurrentTurn: boolean;
  }): Promise<CoverageProcessingResult> {
    const pendingEntries = input.entries.filter(
      ({ ordinal }) =>
        ordinal > input.expectedCursorOrdinal && ordinal <= input.targetBoundaryOrdinal,
    );
    const coverageHash = memoryCoverageHash(pendingEntries);
    if (input.expectedCoverageHash && input.expectedCoverageHash !== coverageHash) {
      return { kind: 'blocked' };
    }
    const priorityEvidence = input.prioritizeCurrentTurn
      ? projectMemoryExtractionEvidence(
          pendingEntries
            .filter(
              ({ event }) =>
                event.runId === input.snapshot.runId && event.turnId === input.snapshot.turnId,
            )
            .map(({ event }) => event),
        )
      : [];
    const requestedEvidenceContainsSensitiveText =
      input.trigger === 'remember' && memoryEvidenceContainsSensitiveText(priorityEvidence);
    const coverage = planMemoryCoverage({
      pendingEntries,
      ...(input.trigger === 'remember' ? { priorityEvidence } : {}),
      sourceEventMessagePositions: input.snapshot.sourceEventMessagePositions,
      sourceMessages: input.snapshot.sourceMessages,
    });
    if (!coverage || coverage.entries.length === 0) {
      return { kind: 'counted_failure', failureClass: 'evidence' };
    }
    return this.processCoverage({
      snapshot: input.snapshot,
      trigger: input.trigger,
      operationId: input.operationId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      coverage,
      entries: input.entries,
      boundaryOrdinal: input.targetBoundaryOrdinal,
      coverageHash,
      requestedEvidenceContainsSensitiveText,
    });
  }

  private async processCoverage(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly coverage: MemoryCoveragePlan;
    readonly entries: readonly MemoryExtractionEventEntry[];
    readonly boundaryOrdinal: number;
    readonly coverageHash: string;
    readonly requestedEvidenceContainsSensitiveText: boolean;
  }): Promise<CoverageProcessingResult> {
    const { snapshot, coverage } = input;
    if (input.requestedEvidenceContainsSensitiveText) {
      return this.commitSensitiveNoOp(input);
    }
    const budget: MemoryModelCallBudget = { remaining: MAX_MEMORY_EXTRACTION_MODEL_CALLS };
    let lastFailureClass: MemoryExtractionFailureClass = 'schema';
    do {
      const attempt = await this.processCoverageAttempt(input, budget);
      if (attempt.kind === 'committed' || attempt.kind === 'blocked') return attempt;
      lastFailureClass = attempt.failureClass;
    } while (budget.remaining > 0);
    return { kind: 'counted_failure', failureClass: lastFailureClass };
  }

  private async processCoverageAttempt(
    input: {
      readonly snapshot: MemoryExtractionSourceSnapshot;
      readonly trigger: MemoryExtractionTrigger;
      readonly operationId: string;
      readonly expectedCursorOrdinal: number;
      readonly coverage: MemoryCoveragePlan;
      readonly entries: readonly MemoryExtractionEventEntry[];
      readonly boundaryOrdinal: number;
      readonly coverageHash: string;
      readonly requestedEvidenceContainsSensitiveText: boolean;
    },
    budget: MemoryModelCallBudget,
  ): Promise<CoverageProcessingResult> {
    const { snapshot, trigger, coverage } = input;
    let requestedItems: readonly MemoryProposalItem[] = [];
    let incidentalItems: readonly MemoryProposalItem[] = [];
    let requestedStatus: 'resolved' | 'not_applicable' | 'unresolved' = 'not_applicable';
    let requestedAdmissionEvidence = coverage.evidence;

    if (coverage.evidence.length > 0 || trigger === 'remember') {
      const firstCall = await this.callModel(
        snapshot,
        buildFirstMemoryProposalPrompt({
          trigger,
          now: this.now(),
          evidence: coverage.evidence,
          sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
        }),
        'proposal',
        budget,
      );
      if (firstCall.kind !== 'ok') return firstCall;
      const first = parseMemoryProposal(firstCall.raw);
      if (!first) return { kind: 'counted_failure', failureClass: 'schema' };
      if (
        trigger !== 'remember' &&
        (first.status !== 'complete' ||
          first.requestedStatus !== 'not_applicable' ||
          first.requestedItems.length > 0)
      ) {
        return { kind: 'counted_failure', failureClass: 'schema' };
      }
      requestedItems = first.requestedItems;
      incidentalItems = first.incidentalItems;
      requestedStatus = first.requestedStatus;

      if (first.status === 'search_required') {
        if (trigger !== 'remember' || !(await this.allowed(snapshot.sessionId))) {
          return { kind: 'blocked' };
        }
        const localizedEntries = searchSameSessionMemoryHistory(
          input.entries,
          input.boundaryOrdinal,
          first.search,
        );
        if (localizedEntries.length === 0) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        const localizedVisibleEvidence = bindProviderVisibleEvidence(
          projectMemoryExtractionEvidence(
            localizedEntries.map(({ event }) => event),
            { snippetTerms: first.search.terms },
          ),
          snapshot.sourceMessages,
          snapshot.sourceEventMessagePositions,
        );
        const localizedEvidence = fitMemoryExtractionEvidence(
          localizedVisibleEvidence,
          undefined,
          snapshot.sourceEventMessagePositions,
        );
        if (!localizedEvidence) {
          return { kind: 'counted_failure', failureClass: 'evidence' };
        }
        if (memoryEvidenceContainsSensitiveText(localizedEvidence)) {
          return this.commitSensitiveNoOp(input);
        }
        if (budget.remaining <= 0) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        const localizedCall = await this.callModel(
          snapshot,
          buildLocalizedMemoryProposalPrompt({
            now: this.now(),
            evidence: localizedEvidence,
            sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
          }),
          'localized',
          budget,
        );
        if (localizedCall.kind !== 'ok') return localizedCall;
        const localized = parseLocalizedMemoryProposal(localizedCall.raw);
        if (!localized) return { kind: 'counted_failure', failureClass: 'schema' };
        if (localized.status === 'cannot_resolve') {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        requestedItems = localized.requestedItems;
        requestedStatus = localized.status;
        requestedAdmissionEvidence = localizedEvidence;
      } else if (first.status === 'cannot_resolve') {
        return { kind: 'counted_failure', failureClass: 'localization' };
      }
    }

    if (requestedStatus === 'unresolved') {
      return { kind: 'counted_failure', failureClass: 'localization' };
    }
    const requestedEvidenceByRef = new Map(
      requestedAdmissionEvidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEvidenceByRef = new Map(
      coverage.evidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEventIds = new Set(coverage.entries.map(({ event }) => event.id));
    const candidates: Array<{
      readonly candidateId: string;
      readonly requested: boolean;
      readonly proposal: MemoryProposalItem;
    }> = [];
    let noOpReason: 'sensitive_information' | undefined;
    proposalLoop: for (const [requested, proposals] of [
      [true, requestedItems],
      [false, incidentalItems],
    ] as const) {
      for (const proposal of proposals) {
        if (deterministicMemoryPolicyRejection(proposal)) {
          if (requested) {
            noOpReason = 'sensitive_information';
            break proposalLoop;
          }
          continue;
        }
        const admission = admitMemoryProposalItemDetailed(
          proposal,
          requested ? requestedEvidenceByRef : coverageEvidenceByRef,
        );
        if (!admission.admitted) {
          if (requested) {
            return {
              kind: 'counted_failure',
              failureClass: admission.reason === 'evidence' ? 'evidence' : 'requested_admission',
            };
          }
          continue;
        }
        if (
          !requested &&
          admission.fields.citedEvents.some((event) => !coverageEventIds.has(event.id))
        ) {
          continue;
        }
        candidates.push({
          candidateId: `candidate_${candidates.length}`,
          requested,
          proposal,
        });
      }
    }

    const writes: MemoryItemWrite[] = [];
    const requestedItemIndexes: number[] = [];
    if (!noOpReason && candidates.length > 0) {
      const canonicalPrompt = buildMemoryCanonicalizationPrompt({
        now: this.now(),
        candidates: candidates.map(({ candidateId, requested, proposal }) => ({
          candidateId,
          requested,
          evidence: proposal.evidence.map(({ sourceRef, quote }) => {
            const source = (requested ? requestedEvidenceByRef : coverageEvidenceByRef).get(
              sourceRef,
            )!;
            return {
              sourceRef,
              quote,
              observedAt: minuteTimestamp(Math.max(...source.events.map((event) => event.ts))),
            };
          }),
        })),
      });
      let byId:
        | Map<
            string,
            NonNullable<ReturnType<typeof parseMemoryCanonicalization>>['results'][number]
          >
        | undefined;
      let canonicalFailureClass: MemoryExtractionFailureClass = 'schema';
      while (!byId && budget.remaining > 0) {
        const canonicalCall = await this.callModel(
          snapshot,
          canonicalPrompt,
          'canonicalize',
          budget,
        );
        if (canonicalCall.kind === 'blocked') return canonicalCall;
        if (canonicalCall.kind === 'counted_failure') {
          canonicalFailureClass = canonicalCall.failureClass;
          continue;
        }
        const results = parseMemoryCanonicalization(canonicalCall.raw)?.results;
        if (!results || results.length !== candidates.length) {
          canonicalFailureClass = 'schema';
          continue;
        }
        const indexed = new Map(results.map((result) => [result.candidateId, result]));
        if (
          indexed.size !== candidates.length ||
          candidates.some(({ candidateId }) => !indexed.has(candidateId))
        ) {
          canonicalFailureClass = 'schema';
          continue;
        }
        byId = indexed;
      }
      if (!byId) return { kind: 'counted_failure', failureClass: canonicalFailureClass };

      for (const candidate of candidates) {
        const result = byId.get(candidate.candidateId)!;
        if (result.status === 'rejected') {
          if (candidate.requested) {
            return { kind: 'counted_failure', failureClass: 'requested_admission' };
          }
          continue;
        }
        const canonicalProposal: MemoryProposalItem = {
          ...result.item,
          evidence: candidate.proposal.evidence,
        };
        if (deterministicMemoryPolicyRejection(canonicalProposal)) {
          if (candidate.requested) {
            noOpReason = 'sensitive_information';
            break;
          }
          continue;
        }
        const admission = admitMemoryProposalItemDetailed(
          canonicalProposal,
          candidate.requested ? requestedEvidenceByRef : coverageEvidenceByRef,
        );
        if (!admission.admitted) {
          if (candidate.requested) {
            return {
              kind: 'counted_failure',
              failureClass: admission.reason === 'evidence' ? 'evidence' : 'requested_admission',
            };
          }
          continue;
        }
        if (candidate.requested) requestedItemIndexes.push(writes.length);
        writes.push(memoryItemWrite(snapshot, admission.fields, candidate.requested));
      }
    }

    if (noOpReason) {
      writes.length = 0;
      requestedItemIndexes.length = 0;
    }

    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    const committed = await this.ports.commit({
      operationId: input.operationId,
      sessionId: snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      nextCursorOrdinal: coverage.entries.at(-1)!.ordinal,
      coverageHash: input.coverageHash,
      items: writes,
      requestedItemIndexes,
      ...(noOpReason ? { noOpReason } : {}),
      trigger,
      ...(trigger === 'compaction' && snapshot.compactionCheckpointId
        ? { compactionCheckpointId: snapshot.compactionCheckpointId }
        : {}),
    });
    return {
      kind: 'committed',
      receipt: committed.receipt,
      nextCursorOrdinal: coverage.entries.at(-1)!.ordinal,
    };
  }

  private async commitSensitiveNoOp(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly coverage: MemoryCoveragePlan;
    readonly coverageHash: string;
  }): Promise<CoverageProcessingResult> {
    if (!(await this.allowed(input.snapshot.sessionId))) return { kind: 'blocked' };
    const nextCursorOrdinal = input.coverage.entries.at(-1)!.ordinal;
    const committed = await this.ports.commit({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      nextCursorOrdinal,
      coverageHash: input.coverageHash,
      items: [],
      requestedItemIndexes: [],
      noOpReason: 'sensitive_information',
      trigger: input.trigger,
      ...(input.trigger === 'compaction' && input.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: input.snapshot.compactionCheckpointId }
        : {}),
    });
    return { kind: 'committed', receipt: committed.receipt, nextCursorOrdinal };
  }

  private async callModel(
    snapshot: MemoryExtractionSourceSnapshot,
    prompt: string,
    stage: 'proposal' | 'localized' | 'canonicalize',
    budget: MemoryModelCallBudget,
  ): Promise<
    | { readonly kind: 'ok'; readonly raw: string }
    | { readonly kind: 'counted_failure'; readonly failureClass: 'provider' }
    | { readonly kind: 'blocked' }
  > {
    if (budget.remaining <= 0) {
      return { kind: 'counted_failure', failureClass: 'provider' };
    }
    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    budget.remaining -= 1;
    const result = await this.ports.generate({
      snapshot,
      prompt,
      stage,
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (result.ok) return { kind: 'ok', raw: result.text };
    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    return result.errorClass === 'provider' || result.errorClass === 'timeout'
      ? { kind: 'counted_failure', failureClass: 'provider' }
      : { kind: 'blocked' };
  }

  private async settleCountedFailure(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly throughOrdinal: number;
    readonly coverageHash: string;
    readonly failureClass: MemoryExtractionFailureClass;
  }): Promise<SettleMemoryExtractionFailureResult | undefined> {
    if (!(await this.allowed(input.snapshot.sessionId))) return undefined;
    return this.ports.settleFailure({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      failedThroughOrdinal: input.throughOrdinal,
      coverageHash: input.coverageHash,
      failureClass: input.failureClass,
      trigger: input.trigger,
      ...(input.trigger === 'compaction' && input.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: input.snapshot.compactionCheckpointId }
        : {}),
    });
  }

  private async allowedOrSettleCompaction(
    snapshot: MemoryExtractionSourceSnapshot,
    operationId: string,
  ): Promise<boolean> {
    const gate = await this.ports.readGate(snapshot.sessionId);
    if (gate.allowed) return true;
    if (gate.reason !== 'unavailable') {
      await this.settleDeniedCompaction(snapshot, operationId);
    }
    return false;
  }

  private async settleCompactionIfCurrentlyDenied(
    snapshot: MemoryExtractionSourceSnapshot,
    operationId: string,
  ): Promise<void> {
    if (snapshot.trigger !== 'compaction') return;
    const gate = await this.ports.readGate(snapshot.sessionId);
    if (!gate.allowed && gate.reason !== 'unavailable') {
      await this.settleDeniedCompaction(snapshot, operationId);
    }
  }

  /**
   * A policy rejection after the checkpoint is intentional, not a crash gap.
   * Settle the whole frozen range atomically without model access or Item writes
   * so a later enabled Compaction cannot recover history from the denied period.
   */
  private async settleDeniedCompaction(
    snapshot: MemoryExtractionSourceSnapshot,
    _operationId: string,
  ): Promise<void> {
    if (snapshot.trigger !== 'compaction') return;
    const entries = await this.ports.readSessionEvents(snapshot.sessionId);
    const checkpoints = await this.ports.readCompactionCheckpoints(snapshot.sessionId);
    const checkpoint = checkpoints.find(
      (candidate) => candidate.checkpointId === snapshot.compactionCheckpointId,
    );
    if (!checkpoint || !compactionCheckpointMatchesSnapshot([checkpoint], snapshot)) return;
    await this.settlePolicyDeniedCheckpoint(snapshot, checkpoint, entries);
  }

  private async settlePolicyDeniedCheckpoint(
    snapshot: MemoryExtractionSourceSnapshot,
    checkpoint: HistoryCompactCheckpoint,
    entries: readonly MemoryExtractionEventEntry[],
  ): Promise<number | undefined> {
    const boundary = compactionBoundaryEntry(entries, checkpoint);
    if (!boundary) return;
    const cursor = await this.ports.readCursor(snapshot.sessionId);
    const expectedCursorOrdinal = cursor?.processedOrdinal ?? 0;
    if (expectedCursorOrdinal >= boundary.ordinal) return expectedCursorOrdinal;
    const coverageEntries = entries.filter(
      ({ ordinal }) => ordinal > expectedCursorOrdinal && ordinal <= boundary.ordinal,
    );
    if (coverageEntries.length === 0) return;
    await this.ports.commit({
      operationId: policySkipOperationId(snapshot.sessionId, checkpoint.checkpointId),
      sessionId: snapshot.sessionId,
      expectedCursorOrdinal,
      nextCursorOrdinal: boundary.ordinal,
      coverageHash: memoryCoverageHash(coverageEntries),
      items: [],
      requestedItemIndexes: [],
      skipReason: 'policy_denied',
      trigger: 'compaction',
      compactionCheckpointId: checkpoint.checkpointId,
    });
    return boundary.ordinal;
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
    snapshot.trigger === 'remember'
      ? snapshot.toolCallId
      : snapshot.trigger === 'extract'
        ? snapshot.terminalEventId
        : snapshot.compactionCheckpointId;
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

function memoryCoverageHash(entries: readonly MemoryExtractionEventEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(entries.map(({ ordinal, event }) => [ordinal, event.id])))
    .digest('hex');
}

function memoryEvidenceContainsSensitiveText(
  evidence: readonly { readonly events: readonly MemoryExtractionEventEntry['event'][] }[],
): boolean {
  return evidence.some(({ events }) =>
    events.some(
      ({ content }) => content?.kind === 'text' && redactSecrets(content.text) !== content.text,
    ),
  );
}

function pendingRetryOperationId(
  triggerOperationId: string,
  pending: PendingMemoryExtractionFailure,
): string {
  return `memory_retry_${createHash('sha256')
    .update(
      JSON.stringify({
        triggerOperationId,
        firstOperationId: pending.firstOperationId,
        coverageHash: pending.coverageHash,
      }),
    )
    .digest('hex')}`;
}

function policySkipOperationId(sessionId: string, checkpointId: string): string {
  return `memory_policy_skip_${createHash('sha256')
    .update(JSON.stringify({ sessionId, checkpointId }))
    .digest('hex')}`;
}

function validSourceContextContract(snapshot: MemoryExtractionSourceSnapshot): boolean {
  if (snapshot.trigger === 'compaction') {
    return (
      snapshot.rebuildSourceContextFromCompactionCheckpoint === true &&
      snapshot.sourceMessages.length === 0 &&
      snapshot.sourceEventMessagePositions === undefined
    );
  }
  return snapshot.rebuildSourceContextFromCompactionCheckpoint === undefined;
}

function compactionBoundaryEntry(
  entries: readonly MemoryExtractionEventEntry[],
  checkpoint: HistoryCompactCheckpoint,
): MemoryExtractionEventEntry | undefined {
  const boundary = checkpoint.memoryExtractionBoundary;
  if (!boundary) return undefined;
  return entries.find(
    ({ event }) =>
      event.id === boundary.runtimeEventId &&
      event.runId === boundary.runId &&
      event.turnId === boundary.turnId,
  );
}

function compactionCheckpointMatchesSnapshot(
  checkpoints: readonly HistoryCompactCheckpoint[],
  snapshot: MemoryExtractionSourceSnapshot,
): boolean {
  if (!snapshot.compactionCheckpointId || !snapshot.compactionBoundaryEventId) return false;
  const checkpoint = checkpoints.find(
    (candidate) => candidate.checkpointId === snapshot.compactionCheckpointId,
  );
  return (
    checkpoint?.memoryExtractionBoundary?.runtimeEventId === snapshot.compactionBoundaryEventId
  );
}

function earliestUnprocessedCompactionCheckpoint(
  checkpoints: readonly HistoryCompactCheckpoint[],
  entries: readonly MemoryExtractionEventEntry[],
  cursorOrdinal: number,
  currentBoundaryOrdinal: number,
  currentCheckpointId?: string,
): HistoryCompactCheckpoint | undefined {
  return checkpoints
    .map((checkpoint) => ({ checkpoint, boundary: compactionBoundaryEntry(entries, checkpoint) }))
    .filter(
      (
        candidate,
      ): candidate is {
        checkpoint: HistoryCompactCheckpoint;
        boundary: MemoryExtractionEventEntry;
      } =>
        candidate.boundary !== undefined &&
        candidate.boundary.ordinal > cursorOrdinal &&
        candidate.boundary.ordinal <= currentBoundaryOrdinal &&
        candidate.checkpoint.checkpointId !== currentCheckpointId,
    )
    .sort((left, right) => left.boundary.ordinal - right.boundary.ordinal)[0]?.checkpoint;
}

function rebuildCompactionSnapshot(
  current: MemoryExtractionSourceSnapshot,
  checkpoint: HistoryCompactCheckpoint | undefined,
  entries: readonly MemoryExtractionEventEntry[],
): MemoryExtractionSourceSnapshot | undefined {
  const boundary = checkpoint?.memoryExtractionBoundary;
  if (!checkpoint || !boundary || boundary.disposition === 'policy_denied') return undefined;
  const sourceContext = buildMemoryCompactionSourceContext(
    entries.map(({ event }) => event),
    boundary.runtimeEventId,
  );
  if (!sourceContext) return undefined;
  return {
    trigger: 'compaction',
    sourceHeader: current.sourceHeader,
    ...(current.sourceSystemPrompt ? { sourceSystemPrompt: current.sourceSystemPrompt } : {}),
    sourceMessages: sourceContext.messages,
    ...(sourceContext.eventMessagePositions
      ? { sourceEventMessagePositions: sourceContext.eventMessagePositions }
      : {}),
    sourceTools: current.sourceTools,
    sourceActiveTools: current.sourceActiveTools,
    ...(current.sourceProviderOptions
      ? { sourceProviderOptions: current.sourceProviderOptions }
      : {}),
    ...(current.sourceMaxOutputTokens !== undefined
      ? { sourceMaxOutputTokens: current.sourceMaxOutputTokens }
      : {}),
    sessionId: current.sessionId,
    runId: current.runId,
    turnId: current.turnId,
    workspaceKey: current.workspaceKey,
    compactionCheckpointId: checkpoint.checkpointId,
    compactionBoundaryEventId: boundary.runtimeEventId,
  };
}

function validCompactionBootstrapOrdinal(
  entries: readonly MemoryExtractionEventEntry[],
  checkpoint: HistoryCompactCheckpoint,
): number | undefined {
  const compactable = entries.filter(({ event }) => isHistoryCompactContentEvent(event));
  const matched = matchHistoryCompactCheckpointPrefix(
    checkpoint,
    compactable.map(({ event }) => event),
  );
  if (matched.reason) return undefined;
  if (checkpoint.phase === 'mid_turn' && checkpoint.headAnchor) {
    const anchorIndex = entries.findIndex(
      ({ event }) => event.id === checkpoint.headAnchor!.runtimeEventId,
    );
    return anchorIndex > 0 ? entries[anchorIndex - 1]!.ordinal : undefined;
  }
  const throughId = matched.coveredRuntimeEvents.at(-1)?.id;
  if (!throughId) return undefined;
  return entries.find(({ event }) => event.id === throughId)?.ordinal;
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
  if (snapshot.trigger === 'compaction') {
    if (!snapshot.compactionCheckpointId || !snapshot.compactionBoundaryEventId) return undefined;
    return entries.find(
      ({ event }) =>
        event.id === snapshot.compactionBoundaryEventId && event.sessionId === snapshot.sessionId,
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
  if (trigger !== 'remember') return unavailableMemoryResult();
  if (receipt.status === 'discarded') return unavailableMemoryResult();
  if (receipt.status === 'remembered' && receipt.requestedItems.length > 0) {
    return { status: 'remembered', requestedItems: receipt.requestedItems };
  }
  return {
    status: 'not_applicable',
    requestedItems: [],
    ...(receipt.noOpReason ? { reason: receipt.noOpReason } : {}),
  };
}

function unavailableMemoryResult(): MemoryRememberResult {
  return { status: 'unavailable', requestedItems: [] };
}
