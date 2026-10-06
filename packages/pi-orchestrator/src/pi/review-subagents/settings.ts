const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Review children always use the parent's Copilot provider and credentials. */
export function resolveReviewSubagentSettings(modelInput?: string, thinkingInput?: string) {
  const rawModel = modelInput?.trim();
  const model = (rawModel?.length ? rawModel : 'gpt-6-luna').replace(/^github-copilot\//, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
    throw new Error(
      'review_subagent_model must be a GitHub Copilot model ID without a thinking suffix.'
    );
  }
  const rawThinkingInput = thinkingInput?.trim();
  const rawThinking = rawThinkingInput?.length ? rawThinkingInput : 'high';
  const thinking = THINKING_LEVELS.find(level => level === rawThinking);
  if (!thinking) {
    throw new Error(
      `review_subagent_thinking_level must be one of: ${THINKING_LEVELS.join(', ')}.`
    );
  }
  return { model, thinking };
}
