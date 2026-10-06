/**
 * @file Tests for the diagnose_ci_failure composite tool.
 *
 * Verifies the `ctx.executeTool()` orchestration flow (get_ci_status →
 * get_workflow_run_logs → summarize_text) against a fake tool context that
 * dispatches nested calls to canned outcomes — testing the business logic,
 * not the SDK plumbing.
 */

import { describe, expect, test } from 'vitest';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { AgentToolCallOutcome } from '@earendil-works/pi-agent-core';
import {
  buildLogText,
  executeDiagnoseCIFailure,
  extractStructured,
  type DiagnoseCIFailureDetails,
} from '../../../src/pi/tools/diagnose-ci-failure';

/** A successful nested-call outcome with the given structured payload. */
function outcome(
  structuredContent: Record<string, unknown>,
  isError = false
): AgentToolCallOutcome {
  return {
    toolCall: { id: 'nested', name: 'nested', arguments: {} },
    result: { content: [{ type: 'text', text: 'nested' }], details: {}, structuredContent },
    isError,
  } as unknown as AgentToolCallOutcome;
}

const CI_STATUS = {
  ref: 'abc123',
  check_runs: [{ conclusion: 'failure' }],
  workflow_runs: [{ id: 42, name: 'CI', conclusion: 'failure' }],
};

/** Handlers for nested tool calls, keyed by tool name. */
type NestedHandlers = Record<string, (args: unknown) => AgentToolCallOutcome>;

/** Build a fake ExtensionToolContext dispatching nested calls to handlers. */
function fakeCtx(handlers: NestedHandlers): ExtensionToolContext {
  return {
    tools: Object.keys(handlers).map(name => ({ name })),
    executeTool: async (name: string, args: unknown) => {
      const handler = handlers[name];
      if (!handler) {
        return outcome({ error: `unknown tool ${name}` }, true);
      }
      return handler(args);
    },
  } as unknown as ExtensionToolContext;
}

const LOGS = {
  run_id: 42,
  jobs: [{ name: 'build', log: 'npm ERR! Test failed. 1 test did not pass.' }],
};

const HAPPY_HANDLERS: NestedHandlers = {
  get_ci_status: () => outcome(CI_STATUS),
  get_workflow_run_logs: () => outcome(LOGS),
  summarize_text: () => outcome({ summary: 'The build failed due to a broken test.' }),
};

describe('diagnose_ci_failure tool - execution', () => {
  test('returns a passing report when CI is green', async () => {
    const ctx = fakeCtx({
      get_ci_status: () => outcome({ ref: 'abc123', check_runs: [], workflow_runs: [] }),
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      ref: 'abc123',
      failed_checks: 0,
      failed_runs: 0,
      summarized: false,
      summary: '',
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('CI is passing');
    expect(result.structuredContent).toMatchObject({ failed_runs: 0, summarized: false });
  });

  test('chains status → logs → summarize and returns the analysis', async () => {
    const logCalls: unknown[] = [];
    const ctx = fakeCtx({
      ...HAPPY_HANDLERS,
      get_workflow_run_logs: args => {
        logCalls.push(args);
        return outcome(LOGS);
      },
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    expect(logCalls).toEqual([{ run_id: 42 }]);
    const details = result.details as DiagnoseCIFailureDetails;
    expect(details).toMatchObject({
      ref: 'abc123',
      failed_checks: 1,
      failed_runs: 1,
      run_id: 42,
      summarized: true,
      summary: 'The build failed due to a broken test.',
    });
    expect((result.content[0] as { text: string }).text).toContain(
      'The build failed due to a broken test.'
    );
    expect(result.structuredContent).toMatchObject({ summarized: true, run_id: 42 });
  });

  test('returns an isError result when the status call fails', async () => {
    const ctx = fakeCtx({
      get_ci_status: () => outcome({ error: 'rate limited' }, true),
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('rate limited');
  });

  test('returns an isError result when log retrieval fails but keeps failure counts', async () => {
    const ctx = fakeCtx({
      ...HAPPY_HANDLERS,
      get_workflow_run_logs: () => outcome({ error: 'run not found' }, true),
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    expect(result.isError).toBe(true);
    const details = result.details as DiagnoseCIFailureDetails;
    expect(details).toMatchObject({ failed_runs: 1, failed_checks: 1, run_id: 42 });
    expect((result.content[0] as { text: string }).text).toContain('run not found');
  });

  test('falls back to the raw log tail when summarization fails', async () => {
    const ctx = fakeCtx({
      ...HAPPY_HANDLERS,
      summarize_text: () => outcome({ error: 'sub-call failed' }, true),
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    expect(result.isError).toBeUndefined();
    const details = result.details as DiagnoseCIFailureDetails;
    expect(details.summarized).toBe(false);
    expect((result.content[0] as { text: string }).text).toContain('Raw log tail');
    expect((result.content[0] as { text: string }).text).toContain('npm ERR!');
  });

  test('skips summarization when summarize_text is not registered', async () => {
    const ctx = fakeCtx({
      get_ci_status: HAPPY_HANDLERS.get_ci_status!,
      get_workflow_run_logs: HAPPY_HANDLERS.get_workflow_run_logs!,
    });

    const result = await executeDiagnoseCIFailure(
      { owner: null, repo: null, pull_number: null, ref: null, focus: null, max_words: null },
      ctx
    );

    const details = result.details as DiagnoseCIFailureDetails;
    expect(details.summarized).toBe(false);
    expect(details.error).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('Log tail');
  });
});

describe('diagnose_ci_failure - helpers', () => {
  test('buildLogText labels jobs and caps very long text', () => {
    const short = buildLogText([{ name: 'build', log: 'ok' }]);
    expect(short).toContain('--- Job: build ---');
    expect(short).toContain('ok');

    const huge = buildLogText([{ name: 'j', log: 'x'.repeat(300_000) }]);
    expect(huge.length).toBeLessThanOrEqual(200_000);
    expect(buildLogText(undefined)).toBe('');
  });

  test('extractStructured prefers structuredContent and falls back to details', () => {
    expect(extractStructured<{ a: number }>(outcome({ a: 1 }))).toEqual({ a: 1 });
    const viaDetails = {
      toolCall: { id: 'x', name: 'x', arguments: {} },
      result: { content: [], details: { b: 2 } },
      isError: false,
    } as unknown as AgentToolCallOutcome;
    expect(extractStructured<{ b: number }>(viaDetails)).toEqual({ b: 2 });
  });
});
