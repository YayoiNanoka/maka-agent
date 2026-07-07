import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SandboxManager } from '../index.js';
import { SandboxManager as SandboxManagerFromSubpath } from '../sandbox/index.js';

describe('runtime sandbox exports', () => {
  it('exports SandboxManager from the runtime barrel and sandbox subpath', () => {
    assert.equal(SandboxManager, SandboxManagerFromSubpath);
  });
});
