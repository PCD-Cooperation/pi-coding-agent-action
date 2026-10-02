/**
 * @file Common patterns and utilities for tool execution.
 *
 * Provides reusable patterns for tool cancellation handling and parameter
 * validation to reduce duplication across tool definitions.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { toStructuredContent } from './metadata';
import type { JsonValue } from '@earendil-works/pi-ai';

/**
 * Type guard: true when `value` is neither `null` nor `undefined`.
 *
 * Strict-capable providers (OpenAI/Anthropic strict tool sampling) emit `null`
 * for absent optional tool fields — our schemas model optionals as required-
 * but-nullable via `nullable()`. Models without strict support may omit the key
 * entirely (`undefined`). This guard normalises both so `prepareParams` can
 * drop absent fields uniformly regardless of the provider.
 *
 * Uses strict `!==` checks (no loose `!=`) to satisfy the `eqeqeq` lint rule
 * while still covering both nullish cases.
 */
export function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Result of a cancelled tool execution.
 */
export interface CancellationResult<TDetails> {
  content: { type: 'text'; text: string }[];
  details: TDetails & { cancelled: true };
}

/**
 * Helper type to extract non-undefined values from a type.
 */
type NonUndefined<T> = T extends undefined ? never : T;

/**
 * Configuration for tool execution with cancellation.
 */
export interface ToolExecutionConfig<TParams, TDetails, TResult> {
  /** The cancellation message to return when signal.aborted is true. */
  cancellationMessage: string;
  /** The cancellation details template (merged with cancelled: true). */
  cancellationDetails: Omit<TDetails, 'cancelled'>;
  /** Function that validates and transforms tool parameters into execution params. */
  prepareParams: (params: TParams) => TResult;
  /** Function that executes the actual operation. The tool context is
   * provided for composite tools that orchestrate other tools via
   * `ctx.executeTool()`. */
  execute: (params: TResult, ctx: ExtensionContext) => Promise<AgentToolResult<TDetails>>;
  /**
   * Maps a successful (or cancelled) result's details to the tool's
   * `structuredContent` (machine-readable result for programmatic callers
   * such as codemode scripts). When provided, every non-error result carries
   * `structuredContent`.
   */
  structuredContent?: (details: TDetails) => JsonValue;
  /**
   * Builds the `details` payload for error results (returned with
   * `isError: true` instead of throwing). Defaults to a zeroed copy of
   * {@link ToolExecutionConfig.cancellationDetails}.
   */
  errorDetails?: (error: unknown) => TDetails;
}

/**
 * Create a cancellation result with the standard structure.
 *
 * @param cancellationMessage - The message to return in the content.
 * @param cancellationDetails - The base details to include (cancelled: true is added automatically).
 * @returns A tool result indicating cancellation.
 */
export function createCancellationResult<TDetails>(
  cancellationMessage: string,
  cancellationDetails: Omit<TDetails, 'cancelled'>
): CancellationResult<TDetails> {
  return {
    content: [{ type: 'text' as const, text: cancellationMessage }],
    details: { ...cancellationDetails, cancelled: true } as TDetails & { cancelled: true },
  };
}

/**
 * Attach `structuredContent` to a result when the tool declares a mapper.
 */
function withStructuredContent<TParams, TDetails, TResult>(
  config: ToolExecutionConfig<TParams, TDetails, TResult>,
  result: AgentToolResult<TDetails>
): AgentToolResult<TDetails> {
  if (!config.structuredContent) {
    return result;
  }
  return { ...result, structuredContent: config.structuredContent(result.details) };
}

/**
 * Create a tool execute function with built-in cancellation and error handling.
 *
 * Wraps the provided execution logic with:
 * - a cancellation check at the start (returns a cancellation result when the
 *   signal is already aborted),
 * - `structuredContent` decoration for programmatic callers (when configured),
 * - an error boundary that reports failures with `isError: true` instead of
 *   throwing, so the model sees the error but `details`/`structuredContent`
 *   stay available to the UI and scripts.
 *
 * @param config - Configuration for the tool execution.
 * @returns An execute function compatible with defineTool.
 *
 * @example
 * ```typescript
 * const executeTool = withCancellation({
 *   cancellationMessage: CANCELLATION_MESSAGE_CREATE_PR,
 *   cancellationDetails: { pullRequestNumber: 0, pullRequestUrl: '', ... },
 *   prepareParams: (params) => {
 *     const { title, body, base, dryRun } = params;
 *     const prParams: CreatePullRequestParams = { title };
 *     if (body !== undefined) prParams.body = body;
 *     if (base !== undefined) prParams.base = base;
 *     if (dryRun !== undefined) prParams.dryRun = dryRun;
 *     return prParams;
 *   },
 *   execute: (prParams) => createPullRequest(prParams),
 * });
 *
 * export const createPRTool = defineTool({
 *   name: 'create_pull_request',
 *   // ... other properties
 *   execute: executeTool,
 * });
 * ```
 */
export function withCancellation<TParams, TDetails, TResult>(
  config: ToolExecutionConfig<TParams, TDetails, TResult>
) {
  return async (
    _toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    _onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    _ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>> => {
    if (signal?.aborted) {
      return withStructuredContent(
        config,
        createCancellationResult(config.cancellationMessage, config.cancellationDetails)
      );
    }

    try {
      const executionParams = config.prepareParams(params);
      const result = await config.execute(executionParams, _ctx);
      return withStructuredContent(config, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details = config.errorDetails
        ? config.errorDetails(error)
        : ({ ...config.cancellationDetails } as TDetails);
      return {
        content: [{ type: 'text' as const, text: `Tool execution failed: ${message}` }],
        details,
        structuredContent: toStructuredContent({ error: message }),
        isError: true,
      };
    }
  };
}

/**
 * Helper to build an object from optional parameters.
 *
 * Filters out undefined values from the provided object, creating a new
 * object with only the defined properties. This is useful when building
 * parameter objects for API calls where undefined values should be omitted.
 *
 * @param params - Object with potentially undefined properties.
 * @returns A new object with only defined properties.
 *
 * @example
 * ```typescript
 * const result = buildParams({
 *   title: 'My Title',
 *   body: undefined,
 *   dryRun: false,
 * });
 * // result = { title: 'My Title', dryRun: false }
 * ```
 */
export function buildParams<T extends Record<string, unknown>>(
  params: T
): Partial<Record<keyof T, NonUndefined<T[keyof T]>>> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as Partial<Record<keyof T, NonUndefined<T[keyof T]>>>;
}
