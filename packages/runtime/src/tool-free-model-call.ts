import type { ModelMessage } from './model-protocol.js';
import {
  lowerNativeAudioMessages,
  lowerModelTools,
  normalizeAiSdkUsage,
  type AiSdkUsageLike,
} from './model-adapter.js';
import { rawFinishReasonString, type NormalizedUsage } from './model-protocol.js';
import type { ModelToolSet } from './model-protocol.js';

export type ToolFreeModelCallContent =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly prompt?: never; readonly messages: readonly ModelMessage[] };

export type ToolFreeModelCallInput = ToolFreeModelCallContent & {
  readonly model: unknown;
  /** Optional original Agent system prefix for cache-compatible auxiliary calls. */
  readonly system?: string;
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly maxOutputTokens: number;
};

export interface ToolFreeModelCallResult {
  readonly text: string;
  readonly usage?: NormalizedUsage;
  readonly finishReason?: string;
}

export interface ProviderPrefixModelCallInput {
  readonly model: unknown;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: ModelToolSet;
  readonly activeTools: readonly string[];
  readonly providerOptions?: unknown;
  readonly abortSignal?: AbortSignal;
  readonly maxOutputTokens?: number;
}

export type ProviderPrefixModelCallResult = ToolFreeModelCallResult;

/** One non-continuing call that preserves the source Agent's provider-visible prefix. */
export async function generateProviderPrefixModelCall(
  input: ProviderPrefixModelCallInput,
): Promise<ProviderPrefixModelCallResult> {
  const ai = (await import('ai')) as unknown as {
    generateText(options: Record<string, unknown>): Promise<{
      text: string;
      toolCalls?: readonly unknown[];
      usage?: AiSdkUsageLike;
      finishReason?: unknown;
    }>;
  };
  const result = await ai.generateText({
    model: input.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    messages: lowerNativeAudioMessages(input.messages),
    tools: lowerModelTools(input.tools),
    activeTools: input.activeTools,
    // Preserve the source request's Tool schema for Provider cache reuse while
    // granting this auxiliary call no Tool authority. This option is local to
    // this request and cannot leak into a later Agent step.
    toolChoice: 'none',
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    maxRetries: 0,
  });
  if ((result.toolCalls?.length ?? 0) > 0) {
    throw new Error('Provider returned a disabled Tool Call');
  }
  const usage = normalizeAiSdkUsage(result.usage, { rawFinishReason: result.finishReason });
  const finishReason = rawFinishReasonString(result.finishReason);
  return {
    text: result.text,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Runs one model call without exposing tools and returns its accounting facts. */
export async function generateToolFreeModelCall(
  input: ToolFreeModelCallInput,
): Promise<ToolFreeModelCallResult> {
  const ai = (await import('ai')) as unknown as {
    generateText(options: Record<string, unknown>): Promise<{
      text: string;
      usage?: AiSdkUsageLike;
      finishReason?: unknown;
    }>;
  };
  const result = await ai.generateText({
    model: input.model,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.prompt === undefined ? { messages: input.messages } : { prompt: input.prompt }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    maxOutputTokens: input.maxOutputTokens,
  });
  const usage = normalizeAiSdkUsage(result.usage, { rawFinishReason: result.finishReason });
  const finishReason = rawFinishReasonString(result.finishReason);
  return {
    text: result.text,
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
