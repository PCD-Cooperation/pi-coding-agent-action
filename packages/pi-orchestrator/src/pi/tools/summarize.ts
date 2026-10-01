/**
 * @file summarize_text tool definition.
 *
 * A platform-agnostic tool that delegates summarization of very long text to
 * a separate one-shot LLM call via the SDK's extension model-call API
 * (`ctx.modelRegistry.complete()`, new in pi-coding-agent 0.86.0). The raw
 * text is sent to the sub-call with request-time authentication resolved by
 * the registry, and only the summary enters the agent's own context —
 * keeping huge inputs (CI logs, long threads, file dumps) out of the main
 * transcript entirely.
 */

import { Type, Static } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import {
  SUMMARIZE_TEXT_PROMPT_SNIPPET,
  SUMMARIZE_TEXT_PROMPT_GUIDELINES,
  SUMMARIZE_TEXT_DESCRIPTION,
  SUMMARIZE_TEXT_PARAM_TEXT_DESCRIPTION,
  SUMMARIZE_TEXT_PARAM_FOCUS_DESCRIPTION,
  SUMMARIZE_TEXT_PARAM_MAX_WORDS_DESCRIPTION,
} from '../prompt';
import { CANCELLATION_MESSAGE_SUMMARIZE } from './constants';
import { nullable, PREFER_STRICT_JSON_SCHEMA } from './schema';
import { isPresent } from './tool-execution';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  PI_ACTION_NAMESPACE,
  READ_ONLY_ANNOTATIONS,
  summarizeOutputSchema,
  toStructuredContent,
} from './metadata';

/** Details returned with each summarize_text tool result. */
export interface SummarizeTextDetails {
  /** The generated summary (empty on cancellation/failure). */
  summary: string;
  /** Model id used for the sub-call. */
  model: string;
  /** Length of the raw input in characters. */
  input_chars: number;
  /** Set when the tool was cancelled via the abort signal. */
  cancelled?: boolean;
  /** Set when the sub-call failed; carries the error message. */
  error?: string;
}

/** Default maxTokens for the one-shot sub-call (roughly fits max_words=300). */
const DEFAULT_SUB_CALL_MAX_TOKENS = 1024;

/** Default target summary length communicated to the sub-call. */
const DEFAULT_MAX_WORDS = 300;

/**
 * Schema for the summarize_text tool.
 */
const summarizeTextSchema = Type.Object(
  {
    text: Type.String({
      description: SUMMARIZE_TEXT_PARAM_TEXT_DESCRIPTION,
    }),
    focus: nullable(
      Type.String({
        description: SUMMARIZE_TEXT_PARAM_FOCUS_DESCRIPTION,
      })
    ),
    max_words: nullable(
      Type.Integer({
        description: SUMMARIZE_TEXT_PARAM_MAX_WORDS_DESCRIPTION,
      })
    ),
  },
  { additionalProperties: false }
);

type SummarizeTextToolParams = Static<typeof summarizeTextSchema>;

/**
 * Build the sub-call system prompt from the focus/max_words parameters.
 */
function buildSubCallPrompt(focus: string | undefined, maxWords: number): string {
  const parts = [
    'You are a summarization assistant. Summarize the user-provided text factually and completely, preserving concrete details (error messages, names, numbers, paths) that matter for debugging or review.',
  ];
  if (focus) {
    parts.push(`Focus the summary on: ${focus}`);
  }
  parts.push(`Keep the summary under ${maxWords} words. Respond with the summary text only.`);
  return parts.join(' ');
}

/**
 * Extract the text content from an assistant message.
 */
function extractAssistantText(message: { content: { type: string; text?: string }[] }): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
    .trim();
}

/**
 * Create the summarize_text tool definition.
 *
 * Uses `ctx.modelRegistry.complete()` (the 0.86.0 extension model-call API)
 * so the sub-call resolves authentication and provider configuration through
 * the same runtime as the session — no API keys or provider wiring needed in
 * the tool itself.
 *
 * @returns The tool definition.
 */
export function createSummarizeToolFactory() {
  return defineTool({
    name: 'summarize_text',
    label: 'Summarize Text',
    description: SUMMARIZE_TEXT_DESCRIPTION,
    promptSnippet: SUMMARIZE_TEXT_PROMPT_SNIPPET,
    promptGuidelines: SUMMARIZE_TEXT_PROMPT_GUIDELINES,
    parameters: summarizeTextSchema,
    constrainedSampling: PREFER_STRICT_JSON_SCHEMA,
    namespace: PI_ACTION_NAMESPACE,
    annotations: READ_ONLY_ANNOTATIONS,
    outputSchema: summarizeOutputSchema,
    execute: async (
      _toolCallId: string,
      params: SummarizeTextToolParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<SummarizeTextDetails>> => {
      const model = ctx.model;
      const baseDetails = {
        summary: '',
        model: model?.id ?? '',
        input_chars: params.text.length,
      };

      if (signal?.aborted) {
        return {
          content: [{ type: 'text' as const, text: CANCELLATION_MESSAGE_SUMMARIZE }],
          details: { ...baseDetails, cancelled: true },
          structuredContent: toStructuredContent({ ...baseDetails, cancelled: true }),
        };
      }

      if (!model) {
        return {
          content: [
            { type: 'text' as const, text: 'No model available for the summarization sub-call' },
          ],
          details: { ...baseDetails, error: 'no model available' },
          structuredContent: toStructuredContent({
            ...baseDetails,
            error: 'no model available',
          }),
          isError: true,
        };
      }

      const maxWords = isPresent(params.max_words) ? params.max_words : DEFAULT_MAX_WORDS;
      const focus = isPresent(params.focus) ? params.focus : undefined;

      try {
        const message = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: buildSubCallPrompt(focus, maxWords),
            messages: [{ role: 'user', content: params.text, timestamp: Date.now() }],
          },
          {
            maxTokens: DEFAULT_SUB_CALL_MAX_TOKENS,
            ...(signal ? { signal } : {}),
          }
        );

        if (message.stopReason === 'error') {
          const errorMessage = message.errorMessage ?? 'unknown sub-call error';
          return {
            content: [{ type: 'text' as const, text: `Summarization failed: ${errorMessage}` }],
            details: { ...baseDetails, error: errorMessage },
            structuredContent: toStructuredContent({ ...baseDetails, error: errorMessage }),
            isError: true,
          };
        }

        const summary = extractAssistantText(message);
        if (!summary) {
          return {
            content: [{ type: 'text' as const, text: 'Summarization returned no text content' }],
            details: { ...baseDetails, error: 'empty summary' },
            structuredContent: toStructuredContent({ ...baseDetails, error: 'empty summary' }),
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: summary }],
          details: { ...baseDetails, summary },
          structuredContent: toStructuredContent({ ...baseDetails, summary }),
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Summarization failed: ${errorMessage}` }],
          details: { ...baseDetails, error: errorMessage },
          structuredContent: toStructuredContent({ ...baseDetails, error: errorMessage }),
          isError: true,
        };
      }
    },
  });
}
