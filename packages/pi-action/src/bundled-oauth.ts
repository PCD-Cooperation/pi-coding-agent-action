import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';

/**
 * Register OAuth implementations through static imports before the bundled
 * action creates a model runtime.
 *
 * Pi normally loads OAuth flows through bundler-opaque relative imports so
 * browser bundles can exclude Node-only login code. A GitHub JavaScript action
 * ships as one standalone file, so those relative modules do not exist beside
 * dist/index.js. The SDK's bundled-flow registry keeps the same lazy auth API
 * while embedding the implementations in the action bundle.
 */
export function registerBundledOAuthFlows(): void {
  registerBunOAuthFlows();
}
