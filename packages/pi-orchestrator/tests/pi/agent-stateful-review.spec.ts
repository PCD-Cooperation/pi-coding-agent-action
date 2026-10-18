import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Agent } from '../../src/pi/agent';
import { createReviewSubmissionCapture, ReviewSubmissionSchema } from '../../src/review/submission';
import { createMockProvider } from '../helpers/tool-mocks';

const logger = { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), notice: vi.fn() };
const config = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  token: 'test-token',
  promptInput: '',
  thinkingLevel: 'off',
  refreshModelCatalog: false,
};
const submission = { coverage: 'complete' as const, coverageNotes: '', findings: [] };

afterEach(() => vi.unstubAllEnvs());

async function runHarness(
  options: {
    submit?: boolean;
    error?: string;
    aborted?: boolean;
    failedWithoutMessage?: boolean;
    throws?: boolean;
    childrenAfterSubmit?: boolean;
  } = {}
) {
  const agent = new Agent(logger, createMockProvider(), { ...config, statefulReview: true });
  const capture = createReviewSubmissionCapture();
  let tool!: ToolDefinition<typeof ReviewSubmissionSchema>;
  await capture.factory({
    on: vi.fn(),
    registerTool: (registered: unknown) => {
      tool = registered as unknown as typeof tool;
    },
  } as unknown as ExtensionAPI);
  Object.assign(agent, {
    reviewSubmissionCapture: capture,
    session: {
      messages: [
        {
          role: 'assistant',
          stopReason: options.failedWithoutMessage ? 'error' : options.aborted ? 'aborted' : 'stop',
        },
      ],
      prompt: async () => {
        if (options.submit) {
          await tool.execute(
            'result',
            submission,
            undefined,
            undefined,
            {} as ExtensionToolContext
          );
        }
        if (options.error) {
          Object.assign(agent, { lastAgentError: options.error });
        }
        if (options.childrenAfterSubmit) {
          Object.assign(agent, { reviewCoordinator: { uncollected: 1 } });
        }
        if (options.throws) {
          throw new Error('session failed');
        }
      },
      getSessionStats: () => ({ tokens: { input: 0, output: 0, total: 0 }, cost: 0 }),
    },
  });
  return agent;
}

describe('stateful review host boundary', () => {
  test('requires a successful submission instead of using assistant prose', async () => {
    const agent = await runHarness();
    await expect(agent.run('Review')).rejects.toThrow('submit_review_result was not called');
  });

  test('returns captured review after the session settles', async () => {
    const agent = await runHarness({ submit: true });
    await expect(agent.run('Review')).resolves.toMatchObject({ review: submission });
  });

  test.each([
    { error: 'provider failed' },
    { aborted: true },
    { throws: true },
    { failedWithoutMessage: true },
  ])('does not return an earlier submission on session failure: %j', async failure => {
    const agent = await runHarness({ submit: true, ...failure });
    await expect(agent.run('Review')).rejects.toThrow();
  });

  test('retains the host child guard even after a successful submission', async () => {
    const agent = await runHarness({ submit: true, childrenAfterSubmit: true });
    await expect(agent.run('Review')).rejects.toThrow('child findings were not collected');
  });

  test.each([undefined, ['read', 'bash', 'write', 'edit', 'get_pr_diff']])(
    'enforces a read-only loadout even with caller tools %j',
    async loadedTools => {
      vi.stubEnv('PI_OFFLINE', '1');
      const agent = new Agent(logger, createMockProvider(), {
        ...config,
        statefulReview: true,
        enableCodemode: true,
        ...(loadedTools ? { loadedTools } : {}),
      });
      try {
        await agent.ready();
        const session = (
          agent as unknown as {
            session: { getActiveToolNames(): string[] };
          }
        ).session;
        const names = session.getActiveToolNames();
        expect(names).toContain('submit_review_result');
        expect(names).toContain('read');
        for (const name of ['bash', 'write', 'edit', 'get_pr_diff']) {
          expect(names).not.toContain(name);
        }
      } finally {
        await agent.dispose();
      }
    }
  );

  test('does not register submission in stateless sessions', async () => {
    vi.stubEnv('PI_OFFLINE', '1');
    const agent = new Agent(logger, createMockProvider(), config);
    try {
      await agent.ready();
      const session = (
        agent as unknown as {
          session: { getAllTools(): { name: string }[] };
        }
      ).session;
      expect(session.getAllTools().map(tool => tool.name)).not.toContain('submit_review_result');
    } finally {
      await agent.dispose();
    }
  });
});
