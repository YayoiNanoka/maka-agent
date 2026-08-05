import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type ModelInfo,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from '@maka/core/llm-connections';
import { lookupModelProviderOverride, openAiAdapterApiProtocol } from '@maka/core/model-metadata';

export interface ResolvedModelRuntime {
  adapter: ProviderRuntimeAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
}

export interface ModelRuntimeConnection {
  readonly providerType: ProviderType;
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
}

export function resolveModelRuntime(
  connection: ModelRuntimeConnection,
  modelId: string,
): ResolvedModelRuntime {
  const override = lookupModelProviderOverride(connection.providerType, modelId);
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType with no per-model override → can't resolve an adapter.
  // Throw a clear error rather than crashing on `.runtimeAdapter`. Mirrors
  // `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!override && !defaults) {
    throw new Error(
      `Unknown provider type "${connection.providerType}"; cannot resolve model runtime.`,
    );
  }
  const apiProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
  if (
    connection.providerType === 'kimi-coding-plan' &&
    apiProtocol !== undefined &&
    apiProtocol !== 'anthropic-messages' &&
    apiProtocol !== 'openai-chat'
  ) {
    throw new Error(
      `Kimi Coding Plan protocol must be openai-chat or anthropic-messages, received ${apiProtocol}`,
    );
  }
  const adapter =
    connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
      ? ({
          kind: 'openai-compatible',
          name: 'provider',
          includeUsage: true,
          passFetch: true,
        } as const)
      : override
        ? runtimeAdapterOverride(override.npm)
        : defaults.runtimeAdapter;
  const configuredBaseUrl = connection.baseUrl?.trim();
  const resolvedBaseUrl = configuredBaseUrl
    ? effectiveBaseUrl(connection)
    : (override?.api ?? effectiveBaseUrl(connection));
  return {
    adapter,
    baseUrl:
      connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
        ? kimiOpenAiBaseUrl(resolvedBaseUrl)
        : resolvedBaseUrl,
    ...(apiProtocol ? { apiProtocol } : {}),
  };
}

export function modelUsesAnthropicMessages(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  const { adapter, apiProtocol } = resolveModelRuntime(connection, modelId);
  return (
    adapter.kind === 'anthropic' ||
    adapter.kind === 'claude-subscription' ||
    (adapter.kind === 'github-copilot' && apiProtocol === 'anthropic-messages')
  );
}

export function modelUsesOpenAiResponses(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  const runtime = resolveModelRuntime(connection, modelId);
  if (runtime.adapter.kind !== 'openai') return false;
  return (
    runtime.adapter.apiProtocol === 'openai-responses' ||
    runtime.apiProtocol === 'openai-responses' ||
    openAiAdapterApiProtocol(modelId, connection.providerType) === 'openai-responses'
  );
}

/** Native OpenAI lanes keep mutable WebSocket continuation state inside ModelAdapter. */
export function modelUsesNativeOpenAiResponses(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  return connection.providerType === 'openai' && modelUsesOpenAiResponses(connection, modelId);
}

function kimiOpenAiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`;
}

function runtimeAdapterOverride(packageName: string): ProviderRuntimeAdapter {
  switch (packageName) {
    case '@ai-sdk/anthropic':
      return { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true };
    case '@ai-sdk/google':
      return { kind: 'google', normalizeBaseUrl: false };
    case '@ai-sdk/openai':
      return { kind: 'openai' };
    case '@ai-sdk/openai-compatible':
      return { kind: 'openai-compatible', name: 'provider' };
    default:
      throw new Error(`models.dev model runtime package ${packageName} is unsupported`);
  }
}
