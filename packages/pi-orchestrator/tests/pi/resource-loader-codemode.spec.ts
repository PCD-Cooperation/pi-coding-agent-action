import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildBuiltinAgentExtensions } from '../../src/pi/resource-loader';
import {
  createReviewSynthesisCapture,
  createReviewUnitCapture,
} from '../../src/review/work-submission';
import type { PiConfig } from '../../src/types';

const unit = {
  id: 'unit-1',
  kind: 'diff' as const,
  basis: 'full' as const,
  paths: ['evidence.txt'],
  spans: [],
  findingIds: [],
  question: 'Inspect pinned evidence',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runScript(config: Partial<PiConfig>, code: string, guard?: ExtensionFactory) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-codemode-capabilities-'));
  const fetch = vi.fn(() => Promise.reject(new Error('Network access is forbidden in this test')));
  vi.stubGlobal('fetch', fetch);
  try {
    writeFileSync(join(directory, 'evidence.txt'), 'Pinned evidence');
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'offline-stub' }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        ...buildBuiltinAgentExtensions({ enableCodemode: true, ...config }),
        ...(guard ? [guard] : []),
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: runtime.getModel('anthropic', 'claude-sonnet-4-5')!,
      thinkingLevel: 'off',
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager: SettingsManager.inMemory(),
      tools: ['read', 'codemode'],
    });
    try {
      const classify = vi.spyOn(runtime, 'classify').mockResolvedValue({
        api: 'stub-classifier',
        timestamp: 0,
        provider: 'stub',
        model: 'classifier',
        answers: {},
        stopReason: 'stop',
      });
      const generateImages = vi.spyOn(runtime, 'generateImages').mockResolvedValue({
        api: 'stub-images',
        timestamp: 0,
        provider: 'stub',
        model: 'image',
        output: [],
        stopReason: 'stop',
      });
      vi.spyOn(runtime, 'getModelOfType').mockImplementation(
        (type, provider, id) => ({ type, provider, id }) as never
      );
      let turns = 0;
      session.agent.streamFunction = model => {
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content:
            turns++ === 0
              ? [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code } }]
              : [{ type: 'text', text: 'Done' }],
          stopReason: turns === 1 ? 'toolUse' : 'stop',
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end();
        return stream;
      };
      await session.bindExtensions({ mode: 'print' });
      await session.prompt('Run the isolated capability regression.');
      const result = session.messages.find(
        message => message.role === 'toolResult' && message.toolName === 'codemode'
      );
      if (result?.role !== 'toolResult') {
        throw new Error('Missing codemode result');
      }
      expect(result.isError).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      return {
        text: result.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n'),
        classifyCalls: classify.mock.calls.length,
        imageCalls: generateImages.mock.calls.length,
        nestedCalls: result.nestedCalls,
      };
    } finally {
      await session.abort();
      session.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const modelScript = `
const evidence = await tools.read({ path: 'evidence.txt' });
let denied = 0;
await Promise.all(['classify', 'generateImages'].flatMap(method =>
  Array.from({ length: 80 }, async () => {
    try {
      if (method === 'classify') {
        await models.classify({ provider: 'stub', id: 'classifier' }, {
          state: { evidence },
          questions: { valid: { type: 'bool', instructions: 'Inspect evidence', criteria: { true: 'Valid', false: 'Invalid' } } }
        });
      } else {
        await models.generateImages({ provider: 'stub', id: 'image' }, {
          input: [{ type: 'text', text: evidence }]
        });
      }
    } catch (error) {
      if (!/models.*not defined/.test(error.message)) throw error;
      denied++;
    }
  })
));
return { denied, evidence: evidence.includes('Pinned evidence'), sum: [1, 2, 3].reduce((a, b) => a + b, 0) };
`;

describe('review codemode SDK capabilities', () => {
  test.each([
    ['stateful', { statefulReview: true }],
    ['worker', { statefulReview: false, reviewWorkUnit: unit }],
    ['synthesis', { statefulReview: false, reviewCoverageSynthesis: true }],
  ] as const)(
    '%s disables model globals but preserves nested reads and data JavaScript',
    async (_role, config) => {
      const result = await runScript(config, modelScript);
      expect(result.text).toContain('"denied":160');
      expect(result.text).toContain('"evidence":true');
      expect(result.text).toContain('"sum":6');
      expect(result.classifyCalls).toBe(0);
      expect(result.imageCalls).toBe(0);
    }
  );

  test('stateless codemode preserves model globals', async () => {
    const result = await runScript({ statefulReview: false }, modelScript);
    expect(result.text).toContain('"denied":0');
    expect(result.text).toContain('"evidence":true');
    expect(result.classifyCalls).toBe(80);
    expect(result.imageCalls).toBe(80);
  });

  test.each(['worker', 'synthesis'] as const)(
    '%s still counts batched SDK nested reads against the 60-call budget',
    async role => {
      const config =
        role === 'worker' ? { reviewWorkUnit: unit } : { reviewCoverageSynthesis: true };
      const capture =
        role === 'worker' ? createReviewUnitCapture(unit) : createReviewSynthesisCapture();
      const result = await runScript(
        config,
        `
      const results = await Promise.allSettled(Array.from({ length: 60 }, () => tools.read({ path: 'evidence.txt' })));
      return {
        reads: results.filter(result => result.status === 'fulfilled').length,
        blocked: results.filter(result => result.status === 'rejected').map(result => result.reason.message)
      };
    `,
        capture.factory
      );
      expect(result.text).toContain('"reads":59');
      expect(result.text).toContain('Review read-tool budget exhausted');
      expect(result.nestedCalls?.calls).toHaveLength(60);
      expect(result.classifyCalls).toBe(0);
      expect(result.imageCalls).toBe(0);
    }
  );
});
