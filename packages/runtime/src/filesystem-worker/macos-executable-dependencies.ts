import { execFile } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';

const OTOOL_EXECUTABLE = '/usr/bin/otool';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_IMAGES = 64;
const DEFAULT_MAX_DEPTH = 8;
const MAX_OTOOL_OUTPUT_BYTES = 1024 * 1024;

export type MacosExecutableDependencyFailureReason =
  | 'inspection_failed'
  | 'dependency_unresolved'
  | 'dependency_limit_exceeded';

export type MacosExecutableDependencyResolution =
  | {
      ok: true;
      runtimeReadableRoots: readonly string[];
      executableRoots: readonly string[];
      dependencyCount: number;
    }
  | {
      ok: false;
      reason: MacosExecutableDependencyFailureReason;
      message: string;
    };

export interface MacosOtoolRequest {
  readonly mode: 'dependencies' | 'load_commands';
  readonly imagePath: string;
  readonly timeoutMs: number;
}

export type MacosOtoolRunner = (request: MacosOtoolRequest) => Promise<string>;

export interface ResolveMacosExecutableDependenciesOptions {
  runOtool?: MacosOtoolRunner;
  resolveFile?: (path: string) => Promise<string | undefined>;
  now?: () => number;
  timeoutMs?: number;
  maxImages?: number;
  maxDepth?: number;
}

interface PendingImage {
  readonly path: string;
  readonly depth: number;
  readonly inheritedRunpaths: readonly string[];
}

export async function resolveMacosExecutableDependencies(
  executable: string,
  options: ResolveMacosExecutableDependenciesOptions = {},
): Promise<MacosExecutableDependencyResolution> {
  const resolveFile = options.resolveFile ?? resolveExistingFile;
  const rootExecutable = await resolveFile(executable);
  if (!rootExecutable) {
    return failure('inspection_failed', 'The executable is unavailable for dependency inspection.');
  }

  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const runOtool = options.runOtool ?? runSystemOtool;
  const executableDirectory = dirname(rootExecutable);
  const runtimeReadableRoots = new Set<string>();
  const executableRoots = new Set<string>([dirname(executable), executableDirectory]);
  const visited = new Set<string>();
  const queue: PendingImage[] = [
    {
      path: rootExecutable,
      depth: 0,
      inheritedRunpaths: [],
    },
  ];
  let dependencyCount = 0;

  try {
    while (queue.length > 0) {
      const image = queue.shift();
      if (!image || visited.has(image.path)) continue;
      if (visited.size >= maxImages || image.depth > maxDepth) {
        throw new DependencyResolutionError(
          'dependency_limit_exceeded',
          'Mach-O dependency inspection exceeded its bounded graph limits.',
        );
      }
      visited.add(image.path);

      const timeoutMs = remainingTimeout(deadline, now);
      const [dependencyOutput, loadCommandOutput] = await Promise.all([
        runOtool({ mode: 'dependencies', imagePath: image.path, timeoutMs }),
        runOtool({ mode: 'load_commands', imagePath: image.path, timeoutMs }),
      ]);
      remainingTimeout(deadline, now);

      const ownRunpaths = resolveRunpaths(
        parseMachORunpaths(loadCommandOutput),
        dirname(image.path),
        executableDirectory,
        image.inheritedRunpaths,
      );
      const runpaths = unique([...ownRunpaths, ...image.inheritedRunpaths]);

      for (const installName of parseMachODependencies(dependencyOutput)) {
        if (isSystemRuntimePath(installName)) continue;
        const candidates = expandInstallName(
          installName,
          dirname(image.path),
          executableDirectory,
          runpaths,
        );
        const dependency = await resolveFirstDependency(candidates, resolveFile);
        if (!dependency) {
          throw new DependencyResolutionError(
            'dependency_unresolved',
            'A Mach-O dependency could not be resolved to an existing file.',
          );
        }
        if (dependency.system || dependency.realPath === image.path) continue;

        dependencyCount += 1;
        addRuntimeDirectory(runtimeReadableRoots, executableRoots, dirname(dependency.lexicalPath));
        addRuntimeDirectory(runtimeReadableRoots, executableRoots, dirname(dependency.realPath));
        queue.push({
          path: dependency.realPath,
          depth: image.depth + 1,
          inheritedRunpaths: runpaths,
        });
      }
    }
  } catch (error) {
    if (error instanceof DependencyResolutionError) {
      return failure(error.reason, error.message);
    }
    return failure('inspection_failed', 'Mach-O dependency inspection failed.');
  }

  return {
    ok: true,
    runtimeReadableRoots: [...runtimeReadableRoots],
    executableRoots: [...executableRoots],
    dependencyCount,
  };
}

function parseMachODependencies(output: string): readonly string[] {
  const dependencies: string[] = [];
  const marker = ' (compatibility version ';
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim();
    const markerIndex = value.indexOf(marker);
    if (markerIndex <= 0) continue;
    dependencies.push(value.slice(0, markerIndex));
  }
  return unique(dependencies);
}

function parseMachORunpaths(output: string): readonly string[] {
  const runpaths: string[] = [];
  let readingRpath = false;
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim();
    if (value.startsWith('cmd ')) {
      readingRpath = value === 'cmd LC_RPATH';
      continue;
    }
    if (!readingRpath) continue;
    const match = /^path\s+(.+?)\s+\(offset\s+\d+\)$/.exec(value);
    if (!match?.[1]) continue;
    runpaths.push(match[1]);
    readingRpath = false;
  }
  return unique(runpaths);
}

function resolveRunpaths(
  runpaths: readonly string[],
  loaderDirectory: string,
  executableDirectory: string,
  inheritedRunpaths: readonly string[],
): readonly string[] {
  return unique(
    runpaths.flatMap((runpath) =>
      expandPathExpression(runpath, loaderDirectory, executableDirectory, inheritedRunpaths),
    ),
  );
}

function expandInstallName(
  installName: string,
  loaderDirectory: string,
  executableDirectory: string,
  runpaths: readonly string[],
): readonly string[] {
  return expandPathExpression(installName, loaderDirectory, executableDirectory, runpaths);
}

function expandPathExpression(
  value: string,
  loaderDirectory: string,
  executableDirectory: string,
  runpaths: readonly string[],
): readonly string[] {
  if (isAbsolute(value)) return [normalize(value)];
  const loaderSuffix = tokenSuffix(value, '@loader_path');
  if (loaderSuffix !== undefined) return [resolve(loaderDirectory, loaderSuffix)];
  const executableSuffix = tokenSuffix(value, '@executable_path');
  if (executableSuffix !== undefined) return [resolve(executableDirectory, executableSuffix)];
  const rpathSuffix = tokenSuffix(value, '@rpath');
  if (rpathSuffix !== undefined) {
    return runpaths.map((runpath) => resolve(runpath, rpathSuffix));
  }
  return [];
}

function tokenSuffix(value: string, token: string): string | undefined {
  if (value === token) return '';
  return value.startsWith(`${token}/`) ? value.slice(token.length + 1) : undefined;
}

async function resolveFirstDependency(
  candidates: readonly string[],
  resolveFile: (path: string) => Promise<string | undefined>,
): Promise<
  | {
      lexicalPath: string;
      realPath: string;
      system: boolean;
    }
  | undefined
> {
  for (const candidate of candidates) {
    if (isSystemRuntimePath(candidate)) {
      return { lexicalPath: candidate, realPath: candidate, system: true };
    }
    const realPath = await resolveFile(candidate);
    if (realPath) return { lexicalPath: candidate, realPath, system: false };
  }
  return undefined;
}

function isSystemRuntimePath(path: string): boolean {
  return (
    path === '/System' ||
    path.startsWith('/System/') ||
    path === '/usr/lib' ||
    path.startsWith('/usr/lib/') ||
    path === '/Library/Apple' ||
    path.startsWith('/Library/Apple/')
  );
}

function addRuntimeDirectory(
  runtimeReadableRoots: Set<string>,
  executableRoots: Set<string>,
  path: string,
): void {
  if (!isAbsolute(path) || isSystemRuntimePath(path)) return;
  runtimeReadableRoots.add(normalize(path));
  executableRoots.add(normalize(path));
}

function remainingTimeout(deadline: number, now: () => number): number {
  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new DependencyResolutionError(
      'dependency_limit_exceeded',
      'Mach-O dependency inspection exceeded its time limit.',
    );
  }
  return remaining;
}

async function resolveExistingFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function runSystemOtool(request: MacosOtoolRequest): Promise<string> {
  const flag = request.mode === 'dependencies' ? '-L' : '-l';
  return await new Promise<string>((resolvePromise, reject) => {
    execFile(
      OTOOL_EXECUTABLE,
      [flag, request.imagePath],
      {
        encoding: 'utf8',
        timeout: request.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OTOOL_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

class DependencyResolutionError extends Error {
  constructor(
    readonly reason: MacosExecutableDependencyFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'DependencyResolutionError';
  }
}

function failure(
  reason: MacosExecutableDependencyFailureReason,
  message: string,
): MacosExecutableDependencyResolution {
  return { ok: false, reason, message };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
