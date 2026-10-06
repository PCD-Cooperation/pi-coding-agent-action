/**
 * @file diagnose_ci_failure tool definition.
 *
 * A composite tool that leverages the pi-coding-agent 0.99.x
 * `ctx.executeTool()` orchestration API to chain three existing tools in a
 * single model turn:
 *
 *   get_ci_status → get_workflow_run_logs → summarize_text
 *
 * Nested calls run through the same validation, hooks, and event pipeline as
 * model-issued calls: they emit `tool_execution_*` events tagged with
 * `parentToolCallId` (feeding our centralized logging), their usage rolls up
 * into this tool's result, and a bounded `nestedCalls` record is kept on the
 * result message for compaction and HTML exports. Nested results never enter
 * the transcript directly — only this tool's composed report does.
 */

import { Type, Static } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  DIAGNOSE_CI_FAILURE_PROMPT_SNIPPET,
  DIAGNOSE_CI_FAILURE_PROMPT_GUIDELINES,
  DIAGNOSE_CI_FAILURE_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_OWNER_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_REPO_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_PULL_NUMBER_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_REF_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_FOCUS_DESCRIPTION,
  DIAGNOSE_CI_FAILURE_PARAM_MAX_WORDS_DESCRIPTION,
} from '../prompt';
import { CANCELLATION_MESSAGE_DIAGNOSE_CI_FAILURE } from './constants';
import { nullable, PREFER_STRICT_JSON_SCHEMA } from './schema';
import { withCancellation, isPresent } from './tool-execution';
import {
  PI_ACTION_NAMESPACE,
  READ_ONLY_ANNOTATIONS,
  diagnoseOutputSchema,
  toStructuredContent,
} from './metadata';
import type { AgentToolResult, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { AgentToolCallOutcome } from '@earendil-works/pi-agent-core';

/** Default cap on the raw log text handed to the summarize sub-call. */
const MAX_LOG_TEXT_CHARS = 200_000;

/** Details returned with each diagnose_ci_failure tool result. */
export interface DiagnoseCIFailureDetails {
  /** Ref the CI status was fetched for ('' while resolving). */
  ref: string;
  /** Number of failed check runs. */
  failed_checks: number;
  /** Number of failed workflow runs. */
  failed_runs: number;
  /** Workflow run whose logs were fetched (undefined when CI passed). */
  run_id?: number;
  /** Whether a summary was produced (false when CI passed or summarization unavailable). */
  summarized: boolean;
  /** The root-cause summary (empty when not summarized). */
  summary: string;
  /** Error message when a nested call failed. */
  error?: string;
  /** Set when the tool was cancelled via the abort signal. */
  cancelled?: boolean;
}

/** Structured shape of the get_ci_status result we consume. */
interface CIStatusStructured {
  ref?: string;
  check_runs?: { conclusion?: string | null }[];
  workflow_runs?: { id?: number; conclusion?: string | null; name?: string }[];
  error?: string;
}

/** Structured shape of the get_workflow_run_logs result we consume. */
interface WorkflowLogsStructured {
  run_id?: number;
  jobs?: { name?: string; log?: string }[];
  error?: string;
}

/** Structured shape of the summarize_text result we consume. */
interface SummarizeStructured {
  summary?: string;
  error?: string;
}

/**
 * Schema for the diagnose_ci_failure tool.
 */
const diagnoseCIFailureSchema = Type.Object(
  {
    owner: nullable(Type.String({ description: DIAGNOSE_CI_FAILURE_PARAM_OWNER_DESCRIPTION })),
    repo: nullable(Type.String({ description: DIAGNOSE_CI_FAILURE_PARAM_REPO_DESCRIPTION })),
    pull_number: nullable(
      Type.Integer({ description: DIAGNOSE_CI_FAILURE_PARAM_PULL_NUMBER_DESCRIPTION })
    ),
    ref: nullable(Type.String({ description: DIAGNOSE_CI_FAILURE_PARAM_REF_DESCRIPTION })),
    focus: nullable(Type.String({ description: DIAGNOSE_CI_FAILURE_PARAM_FOCUS_DESCRIPTION })),
    max_words: nullable(
      Type.Integer({ description: DIAGNOSE_CI_FAILURE_PARAM_MAX_WORDS_DESCRIPTION })
    ),
  },
  { additionalProperties: false }
);

type DiagnoseCIFailureToolParams = Static<typeof diagnoseCIFailureSchema>;

// ---------------------------------------------------------------------------
// Nested-result extraction helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Extract the structured payload of a nested tool outcome. Prefers
 * `structuredContent` (the machine-readable result) and falls back to
 * `details`, which carries the same data on older paths.
 */
export function extractStructured<T>(outcome: AgentToolCallOutcome): T | undefined {
  const candidate =
    outcome.result.structuredContent ??
    (outcome.result.details as Record<string, unknown> | undefined);
  return candidate && typeof candidate === 'object' ? (candidate as T) : undefined;
}

/**
 * Concatenate job logs into a single bounded text blob for the summarize
 * sub-call. Each job is labeled; the text is capped at
 * {@link MAX_LOG_TEXT_CHARS} characters (logs keep their tails, where errors
 * live).
 */
export function buildLogText(jobs: { name?: string; log?: string }[] | undefined): string {
  if (!jobs || jobs.length === 0) {
    return '';
  }
  const combined = jobs
    .map(job => `--- Job: ${job.name ?? 'unknown'} ---\n${job.log ?? ''}`)
    .join('\n\n');
  return combined.length > MAX_LOG_TEXT_CHARS
    ? combined.slice(combined.length - MAX_LOG_TEXT_CHARS)
    : combined;
}

// ---------------------------------------------------------------------------
// Execution flow
// ---------------------------------------------------------------------------

/** Result returned by the diagnose handler. */
type DiagnoseResult = AgentToolResult<DiagnoseCIFailureDetails>;

/** Build a uniform result with matching structured content. */
function diagnoseResult(
  content: string,
  details: DiagnoseCIFailureDetails,
  isError = false
): DiagnoseResult {
  return {
    content: [{ type: 'text', text: content }],
    details,
    structuredContent: toStructuredContent(details),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Run the diagnose_ci_failure flow: status → logs → summary.
 *
 * Never throws for nested-call failures: a failed nested call becomes an
 * `isError` result carrying the underlying error message. Only unexpected
 * local failures propagate to the `withCancellation` error boundary.
 *
 * @param params - Resolved tool parameters.
 * @param ctx - Tool context providing `executeTool` and `tools`.
 */
export async function executeDiagnoseCIFailure(
  params: DiagnoseCIFailureToolParams,
  ctx: ExtensionToolContext
): Promise<DiagnoseResult> {
  const baseDetails: DiagnoseCIFailureDetails = {
    ref: '',
    failed_checks: 0,
    failed_runs: 0,
    summarized: false,
    summary: '',
  };

  // 1. Fetch CI status, filtered to failures.
  const statusOutcome = await ctx.executeTool('get_ci_status', {
    ...(isPresent(params.owner) ? { owner: params.owner } : {}),
    ...(isPresent(params.repo) ? { repo: params.repo } : {}),
    ...(isPresent(params.pull_number) ? { pull_number: params.pull_number } : {}),
    ...(isPresent(params.ref) ? { ref: params.ref } : {}),
    conclusion: 'failure',
  });
  const status = extractStructured<CIStatusStructured>(statusOutcome);
  if (statusOutcome.isError) {
    const error = status?.error ?? 'unknown error';
    return diagnoseResult(`CI status retrieval failed: ${error}`, { ...baseDetails, error }, true);
  }

  const ref = status?.ref ?? '';
  const failedRuns = (status?.workflow_runs ?? []).filter(run => run.conclusion === 'failure');
  const failedChecks = (status?.check_runs ?? []).filter(run => run.conclusion === 'failure');
  const details: DiagnoseCIFailureDetails = {
    ref,
    failed_checks: failedChecks.length,
    failed_runs: failedRuns.length,
    summarized: false,
    summary: '',
  };

  // 2. Green CI: report and stop.
  if (failedRuns.length === 0 && failedChecks.length === 0) {
    return diagnoseResult(
      `CI is passing for ${ref || 'the requested ref'}. No failed checks or workflow runs found.`,
      details
    );
  }

  // 3. Fetch logs of the first failed workflow run.
  let logText = '';
  const failedRun = failedRuns[0];
  if (failedRun && isPresent(failedRun.id)) {
    details.run_id = failedRun.id;
    const logsOutcome = await ctx.executeTool('get_workflow_run_logs', {
      ...(isPresent(params.owner) ? { owner: params.owner } : {}),
      ...(isPresent(params.repo) ? { repo: params.repo } : {}),
      run_id: failedRun.id,
    });
    const logs = extractStructured<WorkflowLogsStructured>(logsOutcome);
    if (logsOutcome.isError) {
      const error = logs?.error ?? 'unknown error';
      return diagnoseResult(
        `CI is failing (${failedRuns.length} failed run(s), ${failedChecks.length} failed check(s)), but log retrieval for run ${failedRun.id} failed: ${error}`,
        { ...details, error },
        true
      );
    }
    logText = buildLogText(logs?.jobs);
  }

  // 4. Summarize the logs (falls back to raw log tail when the tool is absent).
  const summaryFocus = isPresent(params.focus)
    ? params.focus
    : 'errors, root causes, and failed steps';
  const canSummarize = ctx.tools.some(tool => tool.name === 'summarize_text');
  if (logText && canSummarize) {
    const summaryOutcome = await ctx.executeTool('summarize_text', {
      text: logText,
      focus: summaryFocus,
      ...(isPresent(params.max_words) ? { max_words: params.max_words } : {}),
    });
    const summary = extractStructured<SummarizeStructured>(summaryOutcome);
    if (summaryOutcome.isError || !summary?.summary) {
      const error = summary?.error ?? 'summarization returned no content';
      const fallback = `\n\n(Summarization failed: ${error}. Raw log tail follows.)\n\n${logText.slice(-4000)}`;
      return diagnoseResult(
        `CI is failing (${failedRuns.length} failed run(s), ${failedChecks.length} failed check(s)).${fallback}`,
        { ...details, error }
      );
    }
    details.summarized = true;
    details.summary = summary.summary;
    return diagnoseResult(
      `CI is failing (${failedRuns.length} failed run(s), ${failedChecks.length} failed check(s), ref ${ref || 'unknown'}).\n\nRoot-cause analysis:\n${summary.summary}`,
      details
    );
  }

  // 5. No summarization possible: return the bounded raw log tail.
  const logSection = logText ? `\n\nLog tail:\n\n${logText.slice(-4000)}` : '';
  return diagnoseResult(
    `CI is failing (${failedRuns.length} failed run(s), ${failedChecks.length} failed check(s), ref ${ref || 'unknown'}).${logSection}`,
    details
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Create the diagnose_ci_failure tool definition.
 *
 * Platform-agnostic: composes other tools in the orchestrator's tool set via
 * `ctx.executeTool()` rather than talking to any platform API directly.
 *
 * @returns The tool definition.
 */
export function diagnoseCIFailureToolFactory() {
  return defineTool({
    name: 'diagnose_ci_failure',
    label: 'Diagnose CI Failure',
    description: DIAGNOSE_CI_FAILURE_DESCRIPTION,
    promptSnippet: DIAGNOSE_CI_FAILURE_PROMPT_SNIPPET,
    promptGuidelines: DIAGNOSE_CI_FAILURE_PROMPT_GUIDELINES,
    parameters: diagnoseCIFailureSchema,
    constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
    namespace: PI_ACTION_NAMESPACE,
    annotations: READ_ONLY_ANNOTATIONS,
    outputSchema: diagnoseOutputSchema,
    execute: withCancellation<
      DiagnoseCIFailureToolParams,
      DiagnoseCIFailureDetails,
      DiagnoseCIFailureToolParams
    >({
      cancellationMessage: CANCELLATION_MESSAGE_DIAGNOSE_CI_FAILURE,
      cancellationDetails: {
        ref: '',
        failed_checks: 0,
        failed_runs: 0,
        summarized: false,
        summary: '',
      },
      errorDetails: () => ({
        ref: '',
        failed_checks: 0,
        failed_runs: 0,
        summarized: false,
        summary: '',
      }),
      prepareParams: params => params,
      execute: (params, ctx) => executeDiagnoseCIFailure(params, ctx as ExtensionToolContext),
    }),
  });
}
