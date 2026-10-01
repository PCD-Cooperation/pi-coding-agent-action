/**
 * @file Real implementation of PiAgent and PiAgentFactory.
 *
 * Provides the production implementation for Pi agent operations.
 * This is the GitHub Action frontend — it routes streaming events to
 * `process.stdout`.
 *
 * Alternative frontends (web UI, GitHub App) would provide their own factory
 * with different event routing.
 *
 * NOTE: The `PI_PACKAGE_DIR` env var is set once at action startup (in
 * `run.ts`) so the SDK's `getPackageDir()` resolves to the bundled SDK
 * assets in `dist/pi-sdk/`. There is no need to temporarily set/restore
 * the env var around each export call — the action is a single-process,
 * short-lived execution.
 */

import * as core from '@actions/core';
import type {
  PiAgent,
  PiAgentFactory,
  PiConfig,
  Logger,
  AgentEvents,
  PlatformProvider,
} from '@alexanderfortin/pi-orchestrator';
import { Agent, wrapAgent } from '@alexanderfortin/pi-orchestrator';

/**
 * Factory function that creates a PiAgent wrapping a real Pi Agent instance.
 *
 * Routes streaming events to `process.stdout` (the GitHub Action frontend).
 */
export const createRealPiAgent: PiAgentFactory = (
  config: PiConfig,
  logger: Logger,
  provider: PlatformProvider
): PiAgent => {
  const events: AgentEvents = {
    onAuthToken: token => core.setSecret(token),
    onThinkingDelta: delta => process.stdout.write(delta),
    onThinkingComplete: () => process.stdout.write('\n'),
    onPromptComplete: () => process.stdout.write('\n'),
  };
  const agent = new Agent(logger, provider, config, events);

  return wrapAgent(agent);
};
