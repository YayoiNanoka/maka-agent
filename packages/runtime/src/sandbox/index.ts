export { SandboxManager } from './sandbox-manager.js';
export {
  createBuiltinSandboxManager,
  createDefaultSandboxManager,
} from './default-sandbox-manager.js';
export {
  createPermissionAwareSandboxContext,
  deriveFilesystemWorkerProfile,
} from './permission-aware-context.js';
export { createSessionSandboxContextProvider } from './session-context-provider.js';
export {
  createExternalSandboxCapabilities,
  probeActiveSandboxCapabilities,
  sandboxContextForTool,
} from './active-capabilities.js';
export {
  sandboxErrorMetadata,
  serializeSandboxError,
} from './errors.js';
export {
  buildSandboxDiagnosticsSnapshot,
  toSandboxRunTraceProjection,
} from './diagnostics.js';
export type {
  CreatePermissionAwareSandboxContextInput,
  FilesystemWorkerProfileOperation,
  PermissionAwareSandboxContext,
  PermissionAwareSandboxContextAssembly,
} from './permission-aware-context.js';
export type {
  CreateSessionSandboxContextProviderInput,
  SandboxSessionHeader,
  ShellRunSandboxContextFailureReason,
  ShellRunSandboxContextProvider,
  ShellRunSandboxContextResult,
} from './session-context-provider.js';
export type {
  ActiveSandboxCapabilities,
  ActiveSandboxCapability,
  ProbeActiveSandboxCapabilitiesInput,
  SandboxCapabilityUnavailableReason,
} from './active-capabilities.js';
export type {
  SandboxErrorDomain,
  SandboxErrorMetadata,
  SandboxErrorStage,
  SandboxErrorWithMetadata,
} from './errors.js';
export type {
  BuildSandboxDiagnosticsSnapshotInput,
  SandboxDiagnosticCapability,
  SandboxDiagnosticFileSystemMode,
  SandboxDiagnosticNetworkMode,
  SandboxDiagnosticsSnapshot,
  SandboxRunTraceProjection,
} from './diagnostics.js';
export {
  LinuxBubblewrapBackend,
  buildBubblewrapArgv,
  buildNetworkSeccompFilter,
  discoverNestedProtectedMetadataPaths,
} from './linux-sandbox.js';
export type {
  BuildBubblewrapArgvInput,
  LinuxBubblewrapBackendOptions,
} from './linux-sandbox.js';
export {
  LINUX_BWRAP_PROBE_ARGS,
  LINUX_BWRAP_REQUIRED_OPTIONS,
  detectLinuxSandboxCapability,
} from './linux-capability.js';
export type {
  DetectLinuxSandboxCapabilityInput,
  LinuxSandboxCapability,
} from './linux-capability.js';
export {
  MACOS_SEATBELT_BASE_POLICY,
  MACOS_SEATBELT_EXECUTABLE,
  MACOS_SEATBELT_PLATFORM_DEFAULTS_POLICY,
  MacosSeatbeltBackend,
  buildSeatbeltPolicy,
  createSeatbeltExecArgs,
  escapeSeatbeltRegex,
} from './macos-seatbelt.js';
export type {
  BuildSeatbeltPolicyInput,
  BuildSeatbeltPolicyResult,
  CreateSeatbeltExecArgsInput,
} from './macos-seatbelt.js';
export type {
  SandboxBackend,
  SandboxCommand,
  SandboxExecRequest,
  SandboxPathContext,
  SandboxPlatform,
  SandboxSelectionInput,
  SandboxSelectionReason,
  SandboxSelectionResult,
  SandboxTransformFailureReason,
  SandboxTransformManager,
  SandboxEnforcementManager,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './types.js';
