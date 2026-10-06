import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { build } from 'esbuild';
import {
  copyAllSdkAssets,
  copyCodemodeAssets,
  getCodemodeWorkerEntry,
} from '../../../../pi-action/scripts/package';
import { resolvePiSdkPackagePath } from '../../../../pi-action/scripts/pi-sdk';

test.each([
  { childModel: 'gpt-6-luna', childThinking: 'high', parentThinking: 'max' },
  { childModel: 'gpt-6-sol', childThinking: 'medium', parentThinking: 'xhigh' },
])(
  'standalone bundle honors $childModel/$childThinking children and $parentThinking parent with shared OAuth',
  async ({ childModel, childThinking, parentThinking }) => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-review-bundle-'));
    const outputDir = join(directory, 'dist');
    mkdirSync(outputDir);
    try {
      const inject = [join(process.cwd(), 'packages/pi-action/src/import-meta-url.js')];
      const define = { 'import.meta.url': 'importMetaUrl', PI_BUNDLED_NODE: 'true' };
      const sdkPackage = resolvePiSdkPackagePath();
      await build({
        entryPoints: [join(import.meta.dirname, 'fixtures/sdk-entry.ts')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        outfile: join(outputDir, 'index.cjs'),
        define,
        inject,
      });
      await build({
        entryPoints: [getCodemodeWorkerEntry(join(dirname(sdkPackage), 'dist'))],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        outfile: join(outputDir, 'codemode-worker.js'),
        define: { PI_BUNDLED_NODE: 'true' },
      });
      copyCodemodeAssets(directory, sdkPackage);
      copyAllSdkAssets(join(dirname(sdkPackage), 'dist'), join(outputDir, 'pi-sdk'));
      // Reproduce the action's optional-peer-free npm installation. Workspace peers
      // must not hide a missing virtual-module mapping in the standalone bundle.
      const packageRoot = dirname(
        realpathSync(
          join(process.cwd(), 'packages/pi-orchestrator/node_modules/pi-subagents/index.js')
        )
      );
      const isolatedPackage = join(directory, 'pi-subagents');
      cpSync(packageRoot, isolatedPackage, {
        recursive: true,
        filter: path => !path.slice(packageRoot.length).startsWith('/node_modules'),
      });
      mkdirSync(join(isolatedPackage, 'node_modules'));
      for (const dependency of ['@js-temporal/polyfill', 'acorn', 'jiti', 'undici', 'yaml']) {
        mkdirSync(dirname(join(isolatedPackage, 'node_modules', dependency)), { recursive: true });
        symlinkSync(
          realpathSync(join(dirname(packageRoot), dependency)),
          join(isolatedPackage, 'node_modules', dependency)
        );
      }
      const stdout = execFileSync(process.execPath, [join(outputDir, 'index.cjs')], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 40_000,
        env: {
          ...process.env,
          CHILD_MODEL: childModel,
          CHILD_THINKING: childThinking,
          PARENT_THINKING: parentThinking,
          FIXTURE_DIR: directory,
          PI_CODING_AGENT_DIR: directory,
          PI_PACKAGE_DIR: join(outputDir, 'pi-sdk'),
          SUBAGENT_ENTRY: join(isolatedPackage, 'index.js'),
        },
      });
      const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
        efforts: string[];
        requestModels: string[];
        toolSets: string[][];
        exchanges: number;
        masked: number;
        inference: number;
        tokens: number;
        repeatTokens: number;
        parentRead: { text: string }[];
        report: string;
        totalTokens: number;
      };
      expect(report.exchanges).toBe(1);
      expect(report.masked).toBe(1);
      expect(report.efforts.filter(level => level === childThinking)).toHaveLength(4);
      expect(report.efforts.filter(level => level === parentThinking)).toHaveLength(4);
      expect(
        report.toolSets.every(
          tools =>
            tools.includes('codemode') &&
            tools.every(tool =>
              ['read', 'grep', 'find', 'ls', 'codemode', 'subagent', 'wait_subagents'].includes(
                tool
              )
            )
        )
      ).toBe(true);
      expect(
        report.requestModels.filter((_, index) => report.efforts[index] === childThinking)
      ).toEqual(Array(4).fill(childModel));
      expect(
        report.requestModels.filter((_, index) => report.efforts[index] === parentThinking)
      ).toEqual(Array(4).fill('gpt-6-luna'));
      expect(report.inference).toBe(8);
      expect(report.totalTokens).toBe(160);
      expect(report.report).toMatch(/^## Findings/);
      expect(report.report.match(/## Findings/g)).toHaveLength(1);
      expect(report.tokens).toBe(80);
      expect(report.repeatTokens).toBe(0);
      expect(report.parentRead.map(part => part.text).join('\n')).toContain('current PR evidence');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  50_000
);
