import type { SandboxType } from './types.js';

export type SandboxErrorDomain = 'command' | 'background_command' | 'filesystem';
export type SandboxErrorStage =
  | 'capability'
  | 'context'
  | 'validation'
  | 'transform'
  | 'launch'
  | 'protocol'
  | 'operation';

export interface SandboxErrorMetadata {
  domain: SandboxErrorDomain;
  stage: SandboxErrorStage;
  reason: string;
  backend?: SandboxType;
  recoverable: boolean;
  profileName?: string;
  requestId?: string;
}

export interface SandboxErrorWithMetadata extends Error, SandboxErrorMetadata {
  code: string;
}

export function sandboxErrorMetadata(error: unknown): SandboxErrorMetadata | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as Partial<SandboxErrorWithMetadata>;
  if (
    typeof value.domain !== 'string'
    || typeof value.stage !== 'string'
    || typeof value.reason !== 'string'
    || typeof value.recoverable !== 'boolean'
  ) {
    return undefined;
  }
  return {
    domain: value.domain as SandboxErrorDomain,
    stage: value.stage as SandboxErrorStage,
    reason: value.reason,
    recoverable: value.recoverable,
    ...(value.backend ? { backend: value.backend } : {}),
    ...(value.profileName ? { profileName: value.profileName } : {}),
    ...(value.requestId ? { requestId: value.requestId } : {}),
  };
}

export function serializeSandboxError(error: unknown): Record<string, unknown> | undefined {
  const metadata = sandboxErrorMetadata(error);
  if (!metadata) return undefined;
  return { ...metadata };
}
