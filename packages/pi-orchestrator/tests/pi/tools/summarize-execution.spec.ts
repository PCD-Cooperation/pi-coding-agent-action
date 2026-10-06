/**
 * @file Tests for the summarize_text tool (execution behavior).
 *
 * The tool delegates to `ctx.modelRegistry.complete()` — the pi-coding-agent
 * 0.86.0 extension model-call API. Tests mock the extension context's
 * `modelRegistry` and `model` to verify parameter plumbing, summary
 * extraction, error handling, and cancellation.
 */

import { describe, expect, test, vi } from 'vitest';
import { createSummarizeToolFactory } from '@alexanderfortin/pi-orchestrator';

/** Build a mock assistant message for `complete()` responses. */
function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'The build failed due to a missing dependency.' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { input: 10, output: 5, total: 15, cost: { total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Build a mock ExtensionContext with a controllable model registry. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const complete = vi.fn(async () => assistantMessage());
  return {
    ctx: {
      model: { id: 'claude-sonnet-4-5', provider: 'anthropic' },
      modelRegistry: { complete },
      ...overrides,
    } as never,
    complete,
  };
}

/** Narrow the first content block of a tool result to its text. */
function firstText(result: { content: { type: string; text?: string }[] }): string {
  return result.content[0]?.text ?? '';
}

describe('summarize_text tool', () => {
  test('has correct tool name and label', () => {
    const tool = createSummarizeToolFactory();
    expect(tool.name).toBe('summarize_text');
    expect(tool.label).toBe('Summarize Text');
  });

  test('execute returns the summary from the sub-call', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();

    const result = await tool.execute(
      'call-1',
      { text: 'a'.repeat(500) },
      undefined,
      undefined,
      ctx
    );

    expect(complete).toHaveBeenCalledTimes(1);
    const [model, context, options] = complete.mock.calls[0] as never as [
      { id: string },
      { systemPrompt: string; messages: unknown[] },
      { maxTokens: number },
    ];
    expect(model.id).toBe('claude-sonnet-4-5');
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({ role: 'user', content: 'a'.repeat(500) });
    expect(options.maxTokens).toBeGreaterThan(0);
    expect(context.systemPrompt).toContain('under 300 words');

    expect(result.content[0]?.type).toBe('text');
    expect(firstText(result)).toContain('missing dependency');
    expect(result.details).toMatchObject({
      summary: 'The build failed due to a missing dependency.',
      model: 'claude-sonnet-4-5',
      input_chars: 500,
    });
    expect(result.details.cancelled).toBeUndefined();
    expect(result.details.error).toBeUndefined();
  });

  test('execute honors focus and max_words parameters', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();

    await tool.execute(
      'call-1',
      { text: 'log output', focus: 'errors and root causes', max_words: 50 },
      undefined,
      undefined,
      ctx
    );

    const [, context] = complete.mock.calls[0] as never as [unknown, { systemPrompt: string }];
    expect(context.systemPrompt).toContain('errors and root causes');
    expect(context.systemPrompt).toContain('under 50 words');
  });

  test('execute returns cancellation result when signal is aborted', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      'call-1',
      { text: 'text' },
      controller.signal,
      undefined,
      ctx
    );

    expect(complete).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ cancelled: true });
  });

  test('execute reports an error result when no model is available', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx({ model: undefined });

    const result = await tool.execute('call-1', { text: 'text' }, undefined, undefined, ctx);

    expect(complete).not.toHaveBeenCalled();
    expect(firstText(result)).toContain('No model available');
    expect(result.details.error).toBe('no model available');
  });

  test('execute surfaces sub-call stopReason errors', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();
    complete.mockResolvedValueOnce(
      assistantMessage({ stopReason: 'error', errorMessage: '429 rate limited' })
    );

    const result = await tool.execute('call-1', { text: 'text' }, undefined, undefined, ctx);

    expect(firstText(result)).toContain('429 rate limited');
    expect(result.details.error).toBe('429 rate limited');
  });

  test('execute surfaces thrown sub-call exceptions', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();
    complete.mockRejectedValueOnce(new Error('auth missing for provider'));

    const result = await tool.execute('call-1', { text: 'text' }, undefined, undefined, ctx);

    expect(firstText(result)).toContain('auth missing for provider');
    expect(result.details.error).toBe('auth missing for provider');
  });

  test('execute reports empty summaries distinctly', async () => {
    const tool = createSummarizeToolFactory();
    const { ctx, complete } = makeCtx();
    complete.mockResolvedValueOnce(assistantMessage({ content: [] }));

    const result = await tool.execute('call-1', { text: 'text' }, undefined, undefined, ctx);

    expect(firstText(result)).toContain('no text content');
    expect(result.details.error).toBe('empty summary');
  });
});
