import type { Logger, PiAgentFactory, PiConfig, PromptResult, SessionStats } from '../types';
import type { PlatformProvider } from '../platform';

export class CoverageAgentDidNotSettle extends Error {}

export async function executeCoverageHostOperation<T>(
  deadline: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const remaining = Math.min(60_000, deadline - Date.now());
  if (remaining < 1) {
    throw new Error('Coverage host deadline reached');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Coverage host operation exceeded its time budget');
          controller.abort(error);
          reject(error);
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class CoverageUsage {
  private stats: SessionStats | undefined;
  add(value: SessionStats | undefined): void {
    if (!value) {
      return;
    }
    this.stats = {
      inputTokens: (this.stats?.inputTokens ?? 0) + value.inputTokens,
      outputTokens: (this.stats?.outputTokens ?? 0) + value.outputTokens,
      totalTokens: (this.stats?.totalTokens ?? 0) + value.totalTokens,
      cost: (this.stats?.cost ?? 0) + value.cost,
      version: value.version,
    };
  }
  get(): SessionStats | undefined {
    return this.stats ? { ...this.stats } : undefined;
  }
}

async function boundedCleanup(operation: () => unknown): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CoverageAgentDidNotSettle('Coverage agent did not settle after cancellation')
            ),
          5000
        );
      }),
    ]);
  } catch (error) {
    throw error instanceof CoverageAgentDidNotSettle
      ? error
      : new CoverageAgentDidNotSettle(
          'Coverage agent cleanup failed; refusing further admissions',
          { cause: error }
        );
  } finally {
    clearTimeout(timer);
  }
}

export async function executeCoverageAgent(
  factory: PiAgentFactory,
  config: PiConfig,
  logger: Logger,
  provider: PlatformProvider,
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal,
  usage: CoverageUsage
): Promise<PromptResult> {
  signal.throwIfAborted();
  if (timeoutMs < 1) {
    throw new Error('Coverage run deadline reached');
  }
  const agent = factory(config, logger, provider);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: PromptResult | undefined;
  let abortListener: (() => void) | undefined;
  const running = Promise.resolve()
    .then(() => agent.run(prompt))
    .finally(() => {
      settled = true;
    });
  try {
    response = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Coverage worker time budget reached')),
          timeoutMs
        );
        abortListener = () => reject(new Error('Coverage worker cancelled'));
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
        }
      }),
    ]);
    signal.throwIfAborted();
    if (response.error || response.aborted) {
      throw new Error(
        response.aborted
          ? 'Coverage model execution was aborted'
          : 'Coverage model execution failed'
      );
    }
    return response;
  } finally {
    clearTimeout(timer);
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
    try {
      if (!settled) {
        await boundedCleanup(() => agent.abort?.());
        await boundedCleanup(() => agent.dispose());
        await boundedCleanup(() => running.catch(() => undefined));
      }
    } finally {
      try {
        usage.add(response?.sessionStats ?? agent.getSessionStats());
      } catch {
        logger.warning('Coverage agent usage was unavailable');
      }
      await boundedCleanup(() => agent.dispose());
    }
  }
}
