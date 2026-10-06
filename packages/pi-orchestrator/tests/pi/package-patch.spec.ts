/**
 * Tests for the bundled-Node extension loading mechanism.
 *
 * The deployed GitHub Action has no runtime `node_modules` — Pi and its runtime
 * dependencies are bundled into `dist/index.js`. Npm extensions are installed
 * in a temporary directory, so their Pi peer dependencies cannot be resolved
 * from that directory. Since pi-coding-agent 0.86.0, the SDK's loader uses the
 * bundled VIRTUAL_MODULES map (with `tryNative: false`) natively when the
 * build-time `PI_BUNDLED_NODE` define is set (set in package.ts).
 *
 * These tests verify that:
 * 1. The SDK loader still contains the embedded-modules virtual-module branch
 * 2. A temporary extension can import the Pi peer packages from the host runtime
 *
 * If these fail after a Pi SDK upgrade, the loader's embedded-modules path or
 * its test paths need to be updated to match the new SDK layout/behavior.
 */

import { describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
function getLoaderPath(): string {
  return join(
    process.cwd(),
    'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'
  );
}

function getConfigPath(): string {
  return join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/config.js');
}

function getSdkPackagePath(): string {
  const loaderPath = realpathSync(getLoaderPath());
  return dirname(dirname(dirname(dirname(loaderPath))));
}

describe('SDK bundled extension loader patch', () => {
  test('loader.js exists at expected path', () => {
    expect(existsSync(getLoaderPath())).toBe(true);
  });

  test('loader.js uses the embedded-modules virtual-module branch for bundled Node', () => {
    const source = readFileSync(getLoaderPath(), 'utf-8');

    // Guard the 0.86.0 loader shape: PI_BUNDLED_NODE gates `usesEmbeddedModules`,
    // which selects virtualModules + tryNative:false (and tsconfigPaths for TS
    // source runtimes) over dist aliases.
    expect(source).toContain('isBunBinary || isNodeSeaBinary || isBundledNode');
    expect(source).toContain('from "../../config.js"');
    expect(readFileSync(getConfigPath(), 'utf-8')).toContain('PI_BUNDLED_NODE');
    expect(source).toContain('{ virtualModules: await getVirtualModules(), tryNative: false }');
  });

  test('loads peer imports from the host runtime through virtual modules', async () => {
    const sdkPackagePath = getSdkPackagePath();
    const hostDir = mkdtempSync(join(sdkPackagePath, '.pi-extension-host-'));
    const hostPath = join(hostDir, 'index.mjs');

    writeFileSync(
      hostPath,
      [
        "import * as codingAgent from '@earendil-works/pi-coding-agent';",
        "import * as agentCore from '@earendil-works/pi-agent-core';",
        "import * as piAi from '@earendil-works/pi-ai/compat';",
        "import * as piAiOauth from '@earendil-works/pi-ai/oauth';",
        "import * as piAiProviders from '@earendil-works/pi-ai/providers/all';",
        "import * as piTui from '@earendil-works/pi-tui';",
        "import * as typebox from 'typebox';",
        "import * as typeboxCompile from 'typebox/compile';",
        "import * as typeboxValue from 'typebox/value';",
        "import { createJiti } from 'jiti/static';",
        'export { codingAgent, agentCore, piAi, piAiOauth, piAiProviders, piTui, typebox, typeboxCompile, typeboxValue, createJiti };',
      ].join('\n')
    );

    try {
      const {
        createJiti,
        codingAgent,
        agentCore,
        piAi,
        piAiOauth,
        piAiProviders,
        piTui,
        typebox,
        typeboxCompile,
        typeboxValue,
      } = await import(`${pathToFileURL(hostPath).href}?test=${Date.now()}`);
      const virtualModules = {
        typebox,
        'typebox/compile': typeboxCompile,
        'typebox/value': typeboxValue,
        '@earendil-works/pi-agent-core': agentCore,
        '@earendil-works/pi-tui': piTui,
        '@earendil-works/pi-ai': piAi,
        '@earendil-works/pi-ai/compat': piAi,
        '@earendil-works/pi-ai/oauth': piAiOauth,
        '@earendil-works/pi-ai/providers/all': piAiProviders,
        '@earendil-works/pi-coding-agent': codingAgent,
      };
      const extensionDir = mkdtempSync(join(tmpdir(), 'pi-extension-'));
      const extensionPath = join(extensionDir, 'index.ts');

      writeFileSync(
        extensionPath,
        [
          "import { AgentSession } from '@earendil-works/pi-coding-agent';",
          "import { Agent } from '@earendil-works/pi-agent-core';",
          "import { EventStream } from '@earendil-works/pi-ai';",
          "import { EventStream as CompatEventStream } from '@earendil-works/pi-ai/compat';",
          "import * as oauth from '@earendil-works/pi-ai/oauth';",
          "import { builtinProviders } from '@earendil-works/pi-ai/providers/all';",
          "import { Box } from '@earendil-works/pi-tui';",
          "import { Type } from 'typebox';",
          "import { Compile } from 'typebox/compile';",
          "import { Check } from 'typebox/value';",
          'export default () => ({ AgentSession, Agent, EventStream, CompatEventStream, oauth, builtinProviders, Box, Type, Compile, Check });',
        ].join('\n')
      );

      try {
        const jiti = createJiti(import.meta.url, {
          moduleCache: false,
          virtualModules,
          tryNative: false,
        });
        const factory = (await jiti.import(extensionPath, { default: true })) as () => Record<
          string,
          unknown
        >;
        const loaded = factory();

        expect(loaded.AgentSession).toBe(codingAgent.AgentSession);
        expect(loaded.Agent).toBe(agentCore.Agent);
        expect(loaded.EventStream).toBe(piAi.EventStream);
        expect(loaded.CompatEventStream).toBe(piAi.EventStream);
        expect(loaded.builtinProviders).toBe(piAiProviders.builtinProviders);
        expect(loaded.Box).toBe(piTui.Box);
        expect(loaded.Type).toBe(typebox.Type);
        expect(loaded.Compile).toBe(typeboxCompile.Compile);
        expect(loaded.Check).toBe(typeboxValue.Check);
        expect(loaded.oauth).toBeDefined();
      } finally {
        rmSync(extensionDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });
});
