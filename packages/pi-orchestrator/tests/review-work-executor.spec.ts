import { expect, test, vi } from 'vitest';
import type { Logger, PiAgent, PiConfig, PromptResult } from '../src/types';
import { CoverageUsage, executeCoverageAgent } from '../src/review/work-executor';
import { createMockProvider } from './helpers/tool-mocks';

const logger: Logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
};
const config: PiConfig = {
  provider: 'anthropic',
  model: 'test-model',
  token: '',
  thinkingLevel: 'off',
  promptInput: '',
};
const stats = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0, version: 'test' };

test.each(['worker', 'synthesis'] as const)(
  '%s cancellation never exposes captured data and retains usage and cleanup',
  async role => {
    const response: PromptResult = {
      result: 'partial',
      error: undefined,
      aborted: true,
      sessionStats: stats,
      ...(role === 'worker'
        ? {
            reviewUnit: {
              unitId: 'unit',
              status: 'reviewed',
              coveredSpanIds: [],
              reconciledFindingIds: [],
              assessment: 'done',
              limitations: [],
              findings: [],
              followUps: [],
            } as const,
          }
        : { review: { coverage: 'complete', coverageNotes: '', findings: [] } as const }),
    };
    const dispose = vi.fn();
    const agent: PiAgent = {
      run: async () => response,
      getSessionStats: () => stats,
      dispose,
      exportSessionHtml: async () => '',
      exportSessionJsonl: async () => '',
    };
    const usage = new CoverageUsage();
    await expect(
      executeCoverageAgent(
        () => agent,
        config,
        logger,
        createMockProvider(),
        'Review',
        1000,
        new AbortController().signal,
        usage
      )
    ).rejects.toThrow('Coverage model execution was aborted');
    expect(usage.get()).toEqual(stats);
    expect(dispose).toHaveBeenCalledOnce();
  }
);

test('a normal coverage response is retained', async () => {
  const response: PromptResult = { result: 'done', error: undefined, sessionStats: stats };
  const dispose = vi.fn();
  const usage = new CoverageUsage();
  await expect(
    executeCoverageAgent(
      () => ({
        run: async () => response,
        getSessionStats: () => stats,
        dispose,
        exportSessionHtml: async () => '',
        exportSessionJsonl: async () => '',
      }),
      config,
      logger,
      createMockProvider(),
      'Review',
      1000,
      new AbortController().signal,
      usage
    )
  ).resolves.toBe(response);
  expect(dispose).toHaveBeenCalledOnce();
  expect(usage.get()).toEqual(stats);
});
