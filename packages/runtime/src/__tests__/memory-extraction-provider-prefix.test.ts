import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { ModelAdapter } from '../model-adapter.js';
import type { ModelToolSet } from '../model-protocol.js';
import { generateProviderPrefixModelCall } from '../tool-free-model-call.js';

describe('Memory Extraction provider prefix', () => {
  test('disables Tools only for the auxiliary request while preserving the source prefix', async () => {
    const sourceRequests: Record<string, unknown>[] = [];
    let extractionRequest: Record<string, unknown> | undefined;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const sourceModel = new MockLanguageModelV4({
      doStream: async (request) => {
        sourceRequests.push(request as unknown as Record<string, unknown>);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            },
          ]),
        };
      },
    });
    const extractionModel = new MockLanguageModelV4({
      doGenerate: async (request) => {
        extractionRequest = request as unknown as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: '{}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      },
    });
    const providerOptions = { openai: { reasoningEffort: 'medium' } };
    const messages = [{ role: 'user' as const, content: 'Remember concise answers.' }];
    const tools: ModelToolSet = {
      Read: { description: 'Read a file', inputSchema: z.object({ path: z.string() }) },
      memory_remember: { description: 'Remember', inputSchema: z.object({}).strict() },
    };
    const activeTools = ['Read', 'memory_remember'];
    const adapter = new ModelAdapter({
      connection: { providerType: 'openai' } as never,
      apiKey: 'test',
      modelId: 'mock',
      modelFactory: () => sourceModel,
      newId: () => 'id',
      now: () => 0,
      providerOptions,
    });

    const stream = await adapter.startStream({
      model: sourceModel,
      messages,
      tools,
      activeTools,
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
      system: 'source system',
    });
    for await (const _event of stream.events) {
      void _event;
    }

    await generateProviderPrefixModelCall({
      model: extractionModel,
      system: 'source system',
      messages: [...messages, { role: 'user', content: 'Extract long-term memory as JSON.' }],
      tools,
      activeTools,
      providerOptions,
    });

    const secondStream = await adapter.startStream({
      model: sourceModel,
      messages,
      tools,
      activeTools,
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
      system: 'source system',
    });
    for await (const _event of secondStream.events) {
      void _event;
    }

    assert.equal(sourceRequests.length, 2);
    assert.ok(extractionRequest);
    const sourceRequest = sourceRequests[0]!;
    const sourcePrompt = sourceRequest.prompt as readonly unknown[];
    const extractionPrompt = extractionRequest.prompt as readonly unknown[];
    assert.deepEqual(extractionPrompt.slice(0, sourcePrompt.length), sourcePrompt);
    assert.deepEqual(
      extractionPrompt.at(-1),
      expectProviderMessage('user', 'Extract long-term memory as JSON.'),
    );
    assert.deepEqual(extractionRequest.tools, sourceRequest.tools);
    assert.deepEqual(extractionRequest.toolChoice, { type: 'none' });
    assert.deepEqual(sourceRequests[1]!.toolChoice, sourceRequest.toolChoice);
    assert.deepEqual(extractionRequest.providerOptions, sourceRequest.providerOptions);
    assert.equal(extractionRequest.maxOutputTokens, sourceRequest.maxOutputTokens);
  });

  test('rejects a provider Tool Call even when toolChoice none was requested', async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    };
    const violatingModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'unexpected-call',
            toolName: 'Read',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      }),
    });

    await assert.rejects(
      generateProviderPrefixModelCall({
        model: violatingModel,
        messages: [{ role: 'user', content: 'Return JSON only.' }],
        tools: { Read: { description: 'Read', inputSchema: z.object({}).strict() } },
        activeTools: ['Read'],
      }),
      /Provider returned a disabled Tool Call/,
    );
  });
});

function expectProviderMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: 'text', text }], providerOptions: undefined };
}
