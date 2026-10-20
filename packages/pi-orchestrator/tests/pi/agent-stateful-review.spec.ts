import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Agent, wrapAgent } from '../../src/pi/agent';
import { createReviewSubmissionCapture, ReviewSubmissionSchema } from '../../src/review/submission';
import {
  createReviewUnitCapture,
  createReviewSynthesisCapture,
} from '../../src/review/work-submission';
import type { ReviewUnitResult, ReviewWorkUnit } from '../../src/review/work-types';
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

const unit: ReviewWorkUnit = {
  id: 'unit-1',
  kind: 'diff',
  basis: 'full',
  paths: ['src/file.ts'],
  spans: [],
  findingIds: [],
  question: 'Inspect the inline patch',
};
const unitResult: ReviewUnitResult = {
  unitId: unit.id,
  status: 'reviewed',
  coveredSpanIds: [],
  reconciledFindingIds: [],
  assessment: 'No defect found in the supplied patch.',
  limitations: [],
  findings: [],
  followUps: [],
};

async function workHarness(role: 'worker' | 'synthesis', stopReason = 'stop') {
  const agent = new Agent(logger, createMockProvider(), {
    ...config,
    ...(role === 'worker' ? { reviewWorkUnit: unit } : { reviewCoverageSynthesis: true }),
  });
  const capture =
    role === 'worker' ? createReviewUnitCapture(unit) : createReviewSynthesisCapture();
  const tools = new Map<string, ToolDefinition>();
  await capture.factory({
    on: vi.fn(),
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI);
  let submit = true;
  Object.assign(agent, {
    ...(role === 'worker'
      ? { reviewUnitCapture: capture }
      : { reviewSynthesisCapture: capture, reviewSubmissionCapture: capture }),
    session: {
      messages: [{ role: 'assistant', stopReason }],
      prompt: async () => {
        if (submit) {
          const name = role === 'worker' ? 'submit_review_unit_result' : 'request_review_followup';
          await tools
            .get(name)!
            .execute(
              'result',
              role === 'worker'
                ? unitResult
                : { requests: [{ paths: ['src/file.ts'], question: 'Check the caller contract' }] },
              undefined,
              undefined,
              {} as ExtensionToolContext
            );
          submit = false;
        }
      },
      getSessionStats: () => ({ tokens: { input: 10, output: 5, total: 15 }, cost: 0 }),
    },
  });
  return agent;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function isolatedStartupAgent() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-agent-startup-'));
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, 'auth.json'),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  const agent = new Agent(logger, createMockProvider(), {
    ...config,
    token: '',
    cwd,
    reviewWorkUnit: unit,
    loadBuiltinExtensions: false,
  });
  return { agent, runtime, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe('startup cancellation', () => {
  test.each([true, false])(
    'prevents a late ModelRuntime from starting a session (abort first: %s)',
    async abortFirst => {
      const { agent, runtime, cleanup } = await isolatedStartupAgent();
      const entered = deferred();
      const gate = deferred();
      let startupSignal: AbortSignal | undefined;
      const create = vi.spyOn(ModelRuntime, 'create').mockImplementation(async options => {
        startupSignal = options?.signal;
        entered.resolve();
        await gate.promise;
        return runtime;
      });
      const getModel = vi.spyOn(runtime, 'getModel');
      const run = vi.spyOn(agent, 'run');
      const pending = wrapAgent(agent).run('Review inline patch');
      const rejected = expect(pending).rejects.toThrow(/startup/);
      try {
        await entered.promise;
        if (abortFirst) {
          await agent.abort();
          expect(startupSignal?.aborted).toBe(true);
        }
        let drained = false;
        const disposing = agent.dispose().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(startupSignal?.aborted).toBe(true);
        expect(drained).toBe(false);
        gate.resolve();
        await rejected;
        await disposing;
        expect(create).toHaveBeenCalledOnce();
        expect(getModel).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        await expect(agent.ready()).rejects.toThrow('disposed');
        await expect(agent.run('Too late')).rejects.toThrow('disposed');
      } finally {
        gate.resolve();
        await pending.catch(() => undefined);
        await agent.dispose();
        cleanup();
      }
    }
  );

  test('disposes a session that finishes binding after startup was aborted, without prompting', async () => {
    const { agent, runtime, cleanup } = await isolatedStartupAgent();
    vi.spyOn(ModelRuntime, 'create').mockResolvedValue(runtime);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(AgentSession.prototype, 'bindExtensions').mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
    });
    const prompt = vi.spyOn(AgentSession.prototype, 'prompt').mockResolvedValue(undefined);
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const pending = wrapAgent(agent).run('Review inline patch');
    const rejected = expect(pending).rejects.toThrow('startup was aborted');
    try {
      await entered.promise;
      await agent.abort();
      gate.resolve();
      await rejected;
      expect(prompt).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      await agent.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
      await agent.dispose();
      cleanup();
    }
  });

  test('rejects an abort between ready completion and the wrapper prompt', async () => {
    const agent = new Agent(logger, createMockProvider(), config);
    const prompt = vi.fn(async () => undefined);
    Object.assign(agent, {
      sessionInitialized: true,
      session: { prompt, abort: vi.fn(async () => undefined), dispose: vi.fn() },
    });
    const ready = agent.ready.bind(agent);
    vi.spyOn(agent, 'ready').mockImplementation(async () => {
      const initialized = await ready();
      await agent.abort();
      return initialized;
    });
    await expect(wrapAgent(agent).run('Timed-out prompt')).rejects.toThrow('before prompting');
    expect(prompt).not.toHaveBeenCalled();
    await agent.dispose();
  });

  test('keeps a normally initialized legacy session reusable after abort', async () => {
    const agent = new Agent(logger, createMockProvider(), config);
    const prompt = vi.fn(async () => undefined);
    const dispose = vi.fn();
    Object.assign(agent, {
      sessionInitialized: true,
      session: {
        prompt,
        dispose,
        abort: vi.fn(async () => undefined),
        getSessionStats: () => ({ tokens: { input: 0, output: 0, total: 0 }, cost: 0 }),
      },
    });
    const wrapped = wrapAgent(agent);
    await wrapped.run('First prompt');
    await wrapped.abort?.();
    await wrapped.run('Second prompt');
    expect(prompt.mock.calls).toHaveLength(2);
    await wrapped.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('work role host boundary', () => {
  test.each(['worker', 'synthesis'] as const)(
    '%s returns data and usage, then resets capture for the next run',
    async role => {
      const agent = await workHarness(role);
      const response = await agent.run('Inspect supplied patch');
      expect(response.sessionStats?.totalTokens).toBe(15);
      expect(role === 'worker' ? response.reviewUnit : response.reviewFollowUps).toBeDefined();
      expect(response.review).toBeUndefined();
      await expect(agent.run('Next patch')).rejects.toThrow('was not called successfully');
    }
  );

  test.each(['worker', 'synthesis'] as const)(
    '%s never returns captured data after an aborted or error turn',
    async role => {
      for (const reason of ['aborted', 'error']) {
        const agent = await workHarness(role, reason);
        await expect(agent.run('Review')).rejects.toThrow('failed or was aborted');
      }
    }
  );

  test('abort awaits the SDK session becoming idle', async () => {
    const agent = await workHarness('worker');
    let resolve!: () => void;
    const sdkAbort = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done;
        })
    );
    Object.assign(agent, { session: { abort: sdkAbort } });
    let completed = false;
    const pending = agent.abort().then(() => {
      completed = true;
    });
    expect(sdkAbort).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(completed).toBe(false);
    resolve();
    await pending;
    expect(completed).toBe(true);
  });
});

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
