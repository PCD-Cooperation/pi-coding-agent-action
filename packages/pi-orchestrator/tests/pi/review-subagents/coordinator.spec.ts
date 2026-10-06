import { afterEach, expect, test, vi } from 'vitest';
import { ReviewCoordinator } from '../../../src/pi/review-subagents/coordinator';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

const result: AgentToolResult<unknown> = {
  content: [{ type: 'text', text: 'verified finding' }],
  details: undefined,
  usage: {
    input: 10,
    output: 3,
    cacheRead: 20,
    cacheWrite: 0,
    totalTokens: 33,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0, total: 0.4 },
  },
};
afterEach(() => vi.useRealTimers());

test('starts parallel children without waiting, and caps cumulative admissions after collection', async () => {
  const coordinator = new ReviewCoordinator();
  let finish!: (value: AgentToolResult<unknown>) => void;
  const pending = new Promise<AgentToolResult<unknown>>(resolve => {
    finish = resolve;
  });
  const execute = vi.fn(async () => pending);
  expect(coordinator.start(execute, 2)).toBe('review-1');
  expect(() => coordinator.start(execute)).toThrow('already running');
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(coordinator.uncollected).toBe(1);
  finish(result);
  const collected = await coordinator.collect();
  expect(collected.usage?.totalTokens).toBe(33);
  expect(collected.usage?.cost.total).toBe(0.4);
  expect((await coordinator.collect()).usage?.totalTokens).toBe(0);
  coordinator.start(async () => result);
  expect(() => coordinator.start(async () => result)).toThrow('at most 3');
  await coordinator.close();
});

test('concurrent waits never count child spend twice', async () => {
  const coordinator = new ReviewCoordinator();
  coordinator.start(async () => result);
  const waits = await Promise.all([coordinator.collect(), coordinator.collect()]);
  expect(waits.reduce((total, wait) => total + (wait.usage?.totalTokens ?? 0), 0)).toBe(33);
  await coordinator.close();
});

test('deadline aborts children and preserves failed result usage for collection', async () => {
  vi.useFakeTimers();
  const coordinator = new ReviewCoordinator();
  coordinator.start(
    signal =>
      new Promise(resolve =>
        signal.addEventListener('abort', () => resolve({ ...result, isError: true }), {
          once: true,
        })
      )
  );
  await vi.advanceTimersByTimeAsync(300_000);
  const collected = await coordinator.collect();
  expect(collected.content).toEqual([
    { type: 'text', text: expect.stringContaining('incomplete/failed') },
  ]);
  expect(collected.usage?.totalTokens).toBe(33);
  await coordinator.close();
});

test('shutdown aborts outstanding work and permanently closes admissions', async () => {
  const coordinator = new ReviewCoordinator();
  const cancelled = vi.fn();
  coordinator.start(
    signal =>
      new Promise(resolve =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled();
            resolve(result);
          },
          { once: true }
        )
      )
  );
  await Promise.resolve();
  await coordinator.close();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(() => coordinator.start(async () => result)).toThrow();
});

test('custom cumulative limit counts failed children across batches', async () => {
  const coordinator = new ReviewCoordinator(5);
  coordinator.start(async () => {
    throw new Error('child failed');
  }, 3);
  await coordinator.collect();
  coordinator.start(async () => result, 2);
  await coordinator.collect();
  expect(() => coordinator.start(async () => result)).toThrow('at most 5');
  await coordinator.close();
});

test('a limit of one rejects parallel fanout before starting children', async () => {
  const coordinator = new ReviewCoordinator(1);
  const execute = vi.fn(async () => result);
  expect(() => coordinator.start(execute, 2)).toThrow('at most 1');
  expect(execute).not.toHaveBeenCalled();
  coordinator.start(execute);
  await coordinator.collect();
  await coordinator.close();
});
