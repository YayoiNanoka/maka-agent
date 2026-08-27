/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  exactHeadKey,
  formatTriggerMessage,
  initialGate,
  runOnce,
  sendRaftMessage,
  validateConfig,
} from './raft-review-trigger.mjs';

function rawConfig(ledgerPath) {
  return {
    repository: 'apache/maka',
    ledgerPath,
    github: { tokenEnv: 'TEST_GITHUB_TOKEN' },
    classifier: {
      baseUrl: 'https://models.example/v1',
      model: 'classifier-model',
      apiKeyEnv: 'TEST_LLM_TOKEN',
      timeoutMs: 1000,
    },
    raft: {
      profile: 'maka-review-trigger',
      target: '#PR-Review-Leaders',
      orchestrator: 'kabi-sol-review-orchestrator',
    },
    maxTriggersPerRun: 3,
  };
}

function pull(overrides = {}) {
  return {
    number: 123,
    title: 'fix(runtime): retain the original error',
    body: 'Corrects an existing error path.',
    html_url: 'https://github.com/apache/maka/pull/123',
    draft: false,
    labels: [{ name: 'effort/S' }],
    head: { sha: 'abc123' },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('configuration and policy', () => {
  it('normalizes the configured identities and ledger path', () => {
    const config = validateConfig(
      {
        ...rawConfig('state/ledger.json'),
        raft: { ...rawConfig('').raft, orchestrator: '@kabi-sol-review-orchestrator' },
      },
      '/srv/maka/config.json',
    );

    assert.equal(config.repository.fullName, 'apache/maka');
    assert.equal(config.raft.orchestrator, 'kabi-sol-review-orchestrator');
    assert.equal(config.ledgerPath, '/srv/maka/state/ledger.json');
    assert.equal(config.github.apiUrl, 'https://api.github.com');
    assert.equal(config.maxTriggersPerRun, 3);
  });

  it('admits only small, untriggered, non-draft heads', () => {
    const ledger = { version: 1, classifications: {}, triggered: {} };
    const candidate = pull();
    const key = exactHeadKey('apache/maka', candidate.number, candidate.head.sha);

    assert.deepEqual(initialGate(candidate, ledger, 'apache/maka'), {
      eligible: true,
      effortLabel: 'effort/S',
      key,
    });
    assert.equal(initialGate(pull({ draft: true }), ledger, 'apache/maka').reason, 'draft');
    assert.equal(
      initialGate(pull({ labels: [{ name: 'effort/M' }] }), ledger, 'apache/maka').reason,
      'not-small',
    );

    ledger.triggered[key] = { triggeredAt: '2026-01-01T00:00:00Z' };
    assert.equal(initialGate(candidate, ledger, 'apache/maka').reason, 'already-triggered');
  });

  it('renders the exact head and configured orchestrator', () => {
    const config = validateConfig(rawConfig('/tmp/ledger.json'));
    const candidate = pull();
    const key = exactHeadKey('apache/maka', candidate.number, candidate.head.sha);

    assert.equal(
      formatTriggerMessage(config, candidate, 'effort/S', key),
      [
        '@kabi-sol-review-orchestrator automatic review candidate',
        'PR: apache/maka#123 https://github.com/apache/maka/pull/123',
        'Exact head: abc123',
        'Gate: effort/S, classified fix, test passed, mergeable',
        'Trigger: apache/maka#123@abc123',
      ].join('\n'),
    );
  });

  it('passes message content through stdin to the configured Raft profile', async () => {
    const config = validateConfig(rawConfig('/tmp/ledger.json'));
    const captured = { stdin: '' };

    const spawnImpl = (command, args, options) => {
      captured.command = command;
      captured.args = args;
      captured.options = options;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          captured.stdin += chunk.toString();
          callback();
        },
      });
      child.kill = () => {};
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    await sendRaftMessage(config, 'message body', {
      spawnImpl,
      environment: { PATH: '/bin' },
    });

    assert.equal(captured.command, 'raft');
    assert.deepEqual(captured.args, ['message', 'send', '--target', '#PR-Review-Leaders']);
    assert.equal(captured.options.env.RAFT_PROFILE, 'maka-review-trigger');
    assert.equal(captured.stdin, 'message body\n');
    assert.equal(captured.args.includes('message body'), false);
  });

  it('confirms a saved draft only after a thread target mismatch', async () => {
    const config = validateConfig(rawConfig('/tmp/ledger.json'));
    const calls = [];

    const spawnImpl = (command, args, options) => {
      const captured = { command, args, options, stdin: '' };
      calls.push(captured);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      if (options.stdio[0] === 'pipe') {
        child.stdin = new Writable({
          write(chunk, _encoding, callback) {
            captured.stdin += chunk.toString();
            callback();
          },
        });
      }
      child.kill = () => {};
      queueMicrotask(() => {
        if (calls.length === 1) {
          child.stderr.write('Possible thread target mismatch\nDraft saved: yes');
          child.emit('close', 1, null);
        } else {
          child.stdout.write('Message sent');
          child.emit('close', 0, null);
        }
      });
      return child;
    };

    const result = await sendRaftMessage(config, 'message body', { spawnImpl, environment: {} });

    assert.equal(result, 'Message sent');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['message', 'send', '--target', '#PR-Review-Leaders']);
    assert.equal(calls[0].stdin, 'message body\n');
    assert.deepEqual(calls[1].args, [
      'message',
      'send',
      '--target',
      '#PR-Review-Leaders',
      '--send-draft',
      '--anyway',
    ]);
    assert.equal(calls[1].options.stdio[0], 'ignore');
  });

  it('does not retry unrelated Raft failures', async () => {
    const config = validateConfig(rawConfig('/tmp/ledger.json'));
    let calls = 0;

    const spawnImpl = (_command, _args, options) => {
      calls += 1;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      child.kill = () => {};
      assert.equal(options.stdio[0], 'pipe');
      queueMicrotask(() => {
        child.stderr.write('authentication failed');
        child.emit('close', 1, null);
      });
      return child;
    };

    await assert.rejects(
      sendRaftMessage(config, 'message body', { spawnImpl, environment: {} }),
      /authentication failed/u,
    );
    assert.equal(calls, 1);
  });
});

describe('scan', () => {
  it('classifies, sends, persists, and does not trigger the same head twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-raft-review-trigger-'));
    const ledgerPath = join(directory, 'ledger.json');
    const config = validateConfig(rawConfig(ledgerPath));
    const requests = [];
    const messages = [];
    const logs = [];

    const fetchImpl = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/pulls?')) return jsonResponse([pull()]);
      if (String(url).endsWith('/pulls/123'))
        return jsonResponse({ ...pull(), state: 'open', mergeable: true });
      if (String(url).includes('/check-runs?')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (String(url) === 'https://models.example/v1/chat/completions') {
        return jsonResponse({
          choices: [
            {
              message: {
                content: '{"classification":"fix","reason":"Corrects existing behavior."}',
              },
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const dependencies = {
      fetchImpl,
      environment: { TEST_GITHUB_TOKEN: 'github-token', TEST_LLM_TOKEN: 'llm-token' },
      sendMessage: async (message) => messages.push(message),
      logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    };

    try {
      const first = await runOnce(config, dependencies);
      const second = await runOnce(config, dependencies);

      assert.deepEqual(first, { scanned: 1, candidates: 1, triggered: 1, errors: 0 });
      assert.deepEqual(second, { scanned: 1, candidates: 0, triggered: 0, errors: 0 });
      assert.equal(messages.length, 1);
      assert.match(messages[0], /^@kabi-sol-review-orchestrator/u);
      assert.equal(
        requests.filter((request) => request.url.endsWith('/chat/completions')).length,
        1,
      );

      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      assert.ok(ledger.triggered['apache/maka#123@abc123']);
      assert.equal(Object.values(ledger.classifications)[0].classification, 'fix');

      const classifierRequest = requests.find((request) =>
        request.url.endsWith('/chat/completions'),
      );
      const classifierBody = JSON.parse(classifierRequest.init.body);
      const userInput = JSON.parse(classifierBody.messages[1].content);
      assert.deepEqual(userInput, {
        title: 'fix(runtime): retain the original error',
        description: 'Corrects an existing error path.',
      });
      assert.equal(
        logs.some((line) => line.includes('triggered apache/maka#123@abc123')),
        true,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when mergeability, CI, or classification does not pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-raft-review-trigger-'));
    const config = validateConfig(rawConfig(join(directory, 'ledger.json')));
    const pulls = [
      pull({ number: 1, head: { sha: 'head-1' } }),
      pull({ number: 2, head: { sha: 'head-2' } }),
      pull({ number: 3, head: { sha: 'head-3' } }),
    ];
    const messages = [];

    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('/pulls?')) return jsonResponse(pulls);
      if (value.endsWith('/pulls/1')) {
        return jsonResponse({ ...pulls[0], state: 'open', mergeable: false });
      }
      if (value.endsWith('/pulls/2') || value.endsWith('/pulls/3')) {
        const number = Number(value.at(-1));
        return jsonResponse({ ...pulls[number - 1], state: 'open', mergeable: true });
      }
      if (value.includes('/commits/head-1/')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (value.includes('/commits/head-2/')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }],
        });
      }
      if (value.includes('/commits/head-3/')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (value.endsWith('/chat/completions')) {
        return jsonResponse({
          choices: [
            { message: { content: '{"classification":"not_fix","reason":"A refactor."}' } },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      const summary = await runOnce(config, {
        fetchImpl,
        environment: { TEST_GITHUB_TOKEN: 'github-token', TEST_LLM_TOKEN: 'llm-token' },
        sendMessage: async (message) => messages.push(message),
        logger: { info() {}, error() {} },
      });

      assert.deepEqual(summary, { scanned: 3, candidates: 0, triggered: 0, errors: 0 });
      assert.deepEqual(messages, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not classify or send a head that changed during the scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-raft-review-trigger-'));
    const config = validateConfig(rawConfig(join(directory, 'ledger.json')));
    let classifierCalls = 0;
    let sends = 0;

    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('/pulls?')) return jsonResponse([pull()]);
      if (value.endsWith('/pulls/123')) {
        return jsonResponse({
          ...pull({ head: { sha: 'new-head' } }),
          state: 'open',
          mergeable: true,
        });
      }
      if (value.includes('/check-runs?')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (value.endsWith('/chat/completions')) {
        classifierCalls += 1;
        throw new Error('classifier must not run for a stale head');
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      const summary = await runOnce(config, {
        fetchImpl,
        environment: { TEST_GITHUB_TOKEN: 'github-token', TEST_LLM_TOKEN: 'llm-token' },
        sendMessage: async () => {
          sends += 1;
        },
        logger: { info() {}, error() {} },
      });

      assert.deepEqual(summary, { scanned: 1, candidates: 0, triggered: 0, errors: 0 });
      assert.equal(classifierCalls, 0);
      assert.equal(sends, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('caps one scan at the configured number of trigger attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-raft-review-trigger-'));
    const config = validateConfig({
      ...rawConfig(join(directory, 'ledger.json')),
      maxTriggersPerRun: 2,
    });
    const pulls = [1, 2, 3].map((number) =>
      pull({
        number,
        html_url: `https://github.com/apache/maka/pull/${number}`,
        head: { sha: `head-${number}` },
      }),
    );
    const detailRequests = [];
    const messages = [];

    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('/pulls?')) return jsonResponse(pulls);
      const detail = value.match(/\/pulls\/(\d+)$/u);
      if (detail) {
        const number = Number(detail[1]);
        detailRequests.push(number);
        return jsonResponse({ ...pulls[number - 1], state: 'open', mergeable: true });
      }
      if (value.includes('/check-runs?')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (value.endsWith('/chat/completions')) {
        return jsonResponse({
          choices: [{ message: { content: '{"classification":"fix","reason":"Bug fix."}' } }],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      const summary = await runOnce(config, {
        fetchImpl,
        environment: { TEST_GITHUB_TOKEN: 'github-token', TEST_LLM_TOKEN: 'llm-token' },
        sendMessage: async (message) => messages.push(message),
        logger: { info() {}, error() {} },
      });

      assert.deepEqual(summary, { scanned: 3, candidates: 2, triggered: 2, errors: 0 });
      assert.deepEqual(detailRequests, [1, 2]);
      assert.equal(messages.length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a candidate without sending or marking it during dry-run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-raft-review-trigger-'));
    const ledgerPath = join(directory, 'ledger.json');
    const config = validateConfig(rawConfig(ledgerPath));
    let sends = 0;
    const logs = [];

    const fetchImpl = async (url) => {
      const value = String(url);
      if (value.includes('/pulls?')) return jsonResponse([pull()]);
      if (value.endsWith('/pulls/123')) {
        return jsonResponse({ ...pull(), state: 'open', mergeable: true });
      }
      if (value.includes('/check-runs?')) {
        return jsonResponse({
          check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        });
      }
      if (value.endsWith('/chat/completions')) {
        return jsonResponse({
          choices: [
            { message: { content: '```json\n{"classification":"fix","reason":"Bug fix."}\n```' } },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    try {
      const summary = await runOnce(config, {
        fetchImpl,
        environment: { TEST_GITHUB_TOKEN: 'github-token', TEST_LLM_TOKEN: 'llm-token' },
        sendMessage: async () => {
          sends += 1;
        },
        logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
        dryRun: true,
      });

      assert.deepEqual(summary, { scanned: 1, candidates: 1, triggered: 0, errors: 0 });
      assert.equal(sends, 0);
      assert.equal(
        logs.some((line) => line.startsWith('[dry-run] @kabi-sol-review-orchestrator')),
        true,
      );
      await assert.rejects(readFile(ledgerPath, 'utf8'), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
