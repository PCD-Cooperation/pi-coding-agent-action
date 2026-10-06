import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';

export const CHILD_TIMEOUT_MS = 300_000;
export const CHILD_TOOLS = ['read', 'grep', 'find', 'ls', 'codemode'];

interface Job {
  id: string;
  collected: boolean;
  settled: boolean;
  children: number;
  controller: AbortController;
  result: Promise<AgentToolResult<unknown>>;
}

/** Per-session admission and exactly-once usage collection, including failed children. */
export class ReviewCoordinator {
  private jobs: Job[] = [];
  private closed = false;
  private admitted = 0;

  constructor(private readonly maxChildren = 3) {
    if (!Number.isSafeInteger(maxChildren) || maxChildren < 1) {
      throw new Error('max_review_subagents must be a positive safe integer.');
    }
  }

  get uncollected(): number {
    return this.jobs.filter(job => !job.collected).length;
  }

  start(execute: (signal: AbortSignal) => Promise<AgentToolResult<unknown>>, children = 1): string {
    if (this.closed || this.admitted + children > this.maxChildren) {
      throw new Error(
        `Review subagent budget exhausted: at most ${this.maxChildren} children per review.`
      );
    }
    if (this.jobs.some(job => !job.settled)) {
      throw new Error(
        'A review batch is already running. Launch independent scopes together in one subagent call, or collect the current batch first.'
      );
    }
    if (!Number.isInteger(children) || children < 1) {
      throw new Error('Invalid child count');
    }
    this.admitted += children;
    const controller = new AbortController();
    const id = `review-${this.jobs.length + 1}`;
    const job: Job = {
      id,
      controller,
      collected: false,
      settled: false,
      children,
      result: Promise.resolve({ content: [], details: undefined }),
    };
    // Reserve before execution: sibling calls cannot oversubscribe the cumulative budget.
    this.jobs.push(job);
    const timer = setTimeout(
      () => controller.abort(new Error('Review child timed out')),
      CHILD_TIMEOUT_MS
    );
    job.result = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return execute(controller.signal);
      })
      .catch(error => ({
        content: [{ type: 'text' as const, text: String(error) }],
        details: { failed: true },
        isError: true,
      }))
      .finally(() => {
        job.settled = true;
        clearTimeout(timer);
      });
    return id;
  }

  async collect(signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const pending = this.jobs.filter(job => !job.collected);
    const cancel = () => {
      for (const job of pending) {
        job.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    let results: AgentToolResult<unknown>[];
    try {
      results = await Promise.all(pending.map(job => job.result));
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    const usage: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const parts: string[] = [];
    for (const [index, job] of pending.entries()) {
      const result = results[index]!;
      parts.push(
        `${job.id} (${result.isError ? 'incomplete/failed' : 'completed'}):\n${result.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')}`
      );
      if (job.collected) {
        continue;
      }
      job.collected = true;
      if (result.usage) {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
          usage[key] += result.usage[key];
        }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
          usage.cost[key] += result.usage.cost[key];
        }
      }
    }
    return {
      content: [{ type: 'text', text: parts.join('\n\n') || 'No uncollected review children.' }],
      details: {
        children: pending.reduce((total, job) => total + job.children, 0),
        batches: pending.map((job, index) => ({
          id: job.id,
          status: results[index]!.isError ? 'failed' : 'completed',
          details: results[index]!.details,
        })),
      },
      usage,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs) {
      job.controller.abort();
    }
    await Promise.all(this.jobs.map(job => job.result));
  }
}
