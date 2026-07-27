import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, test } from 'node:test';

import {
  resolveMacosExecutableDependencies,
  type MacosOtoolRequest,
} from '../filesystem-worker/macos-executable-dependencies.js';

describe('macOS executable dependency resolution', () => {
  test('adds lexical and canonical directories for recursive absolute dependencies', async () => {
    const executable = '/opt/homebrew/Cellar/ripgrep/15.1.0/bin/rg';
    const lexicalPcre = '/opt/homebrew/opt/pcre2/lib/libpcre2-8.0.dylib';
    const canonicalPcre = '/opt/homebrew/Cellar/pcre2/10.45/lib/libpcre2-8.0.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [lexicalPcre, canonicalPcre],
        [canonicalPcre, canonicalPcre],
      ]),
      dependencies: new Map([
        [
          executable,
          machoDependencies(executable, [
            lexicalPcre,
            '/usr/lib/libiconv.2.dylib',
            '/usr/lib/libSystem.B.dylib',
          ]),
        ],
        [
          canonicalPcre,
          machoDependencies(canonicalPcre, [lexicalPcre, '/usr/lib/libSystem.B.dylib']),
        ],
      ]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dependencyCount, 1);
    assert.deepEqual(result.runtimeReadableRoots, [
      '/opt/homebrew/opt/pcre2/lib',
      '/opt/homebrew/Cellar/pcre2/10.45/lib',
    ]);
    assert.deepEqual(result.executableRoots, [
      dirname(executable),
      '/opt/homebrew/opt/pcre2/lib',
      '/opt/homebrew/Cellar/pcre2/10.45/lib',
    ]);
  });

  test('resolves rpath, loader_path, and executable_path dependencies recursively', async () => {
    const executable = '/Applications/Maka.app/Contents/Resources/bin/rg';
    const library = '/Applications/Maka.app/Contents/Resources/lib/libsearch.dylib';
    const loaderLibrary = '/Applications/Maka.app/Contents/Resources/lib/libloader.dylib';
    const executableLibrary = '/Applications/Maka.app/Contents/Resources/bin/libexec.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [library, library],
        [loaderLibrary, loaderLibrary],
        [executableLibrary, executableLibrary],
      ]),
      dependencies: new Map([
        [executable, machoDependencies(executable, ['@rpath/libsearch.dylib'])],
        [
          library,
          machoDependencies(library, [
            '@loader_path/libloader.dylib',
            '@executable_path/libexec.dylib',
          ]),
        ],
        [loaderLibrary, machoDependencies(loaderLibrary, ['/usr/lib/libSystem.B.dylib'])],
        [executableLibrary, machoDependencies(executableLibrary, [])],
      ]),
      loadCommands: new Map([[executable, machoRunpaths(['@executable_path/../lib'])]]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dependencyCount, 3);
    assert.deepEqual(result.runtimeReadableRoots, [
      '/Applications/Maka.app/Contents/Resources/lib',
      '/Applications/Maka.app/Contents/Resources/bin',
    ]);
  });

  test('fails closed when an rpath dependency cannot be resolved', async () => {
    const executable = '/apps/bin/rg';
    const fixture = dependencyFixture({
      files: new Map([[executable, executable]]),
      dependencies: new Map([
        [executable, machoDependencies(executable, ['@rpath/libmissing.dylib'])],
      ]),
      loadCommands: new Map([[executable, machoRunpaths(['/apps/lib'])]]),
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.deepEqual(result, {
      ok: false,
      reason: 'dependency_unresolved',
      message: 'A Mach-O dependency could not be resolved to an existing file.',
    });
  });

  test('bounds recursive dependency graphs', async () => {
    const executable = '/apps/bin/rg';
    const first = '/apps/lib/libfirst.dylib';
    const second = '/apps/lib/libsecond.dylib';
    const fixture = dependencyFixture({
      files: new Map([
        [executable, executable],
        [first, first],
        [second, second],
      ]),
      dependencies: new Map([
        [executable, machoDependencies(executable, [first])],
        [first, machoDependencies(first, [second])],
        [second, machoDependencies(second, [])],
      ]),
      maxDepth: 1,
    });

    const result = await resolveMacosExecutableDependencies(executable, fixture);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'dependency_limit_exceeded');
  });
});

function dependencyFixture(input: {
  files: ReadonlyMap<string, string>;
  dependencies: ReadonlyMap<string, string>;
  loadCommands?: ReadonlyMap<string, string>;
  maxDepth?: number;
}) {
  return {
    resolveFile: async (path: string) => input.files.get(path),
    runOtool: async (request: MacosOtoolRequest) => {
      const output =
        request.mode === 'dependencies'
          ? input.dependencies.get(request.imagePath)
          : (input.loadCommands?.get(request.imagePath) ?? '');
      if (output === undefined) throw new Error(`Missing otool fixture: ${request.imagePath}`);
      return output;
    },
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
  };
}

function machoDependencies(image: string, dependencies: readonly string[]): string {
  return [
    `${image}:`,
    ...dependencies.map(
      (dependency) => `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`,
    ),
  ].join('\n');
}

function machoRunpaths(runpaths: readonly string[]): string {
  return runpaths
    .map(
      (runpath, index) => `Load command ${index}
          cmd LC_RPATH
      cmdsize 48
         path ${runpath} (offset 12)`,
    )
    .join('\n');
}
