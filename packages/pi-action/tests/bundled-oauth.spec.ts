import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { build } from 'esbuild';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bundled OAuth flows', () => {
  test('resolves OpenAI Codex OAuth from a standalone bundle', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pi-action-bundled-oauth-'));
    tempDirs.push(outputDir);
    const bundlePath = join(outputDir, 'index.mjs');

    await build({
      entryPoints: [join(import.meta.dirname, 'fixtures/bundled-oauth-entry.ts')],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: bundlePath,
    });

    const stdout = execFileSync(process.execPath, [bundlePath], {
      cwd: outputDir,
      encoding: 'utf8',
    });

    expect(JSON.parse(stdout)).toEqual({ apiKey: 'bundled-access-token' });
  });

  test('renews Copilot OAuth concurrently from a standalone bundle', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'pi-action-bundled-copilot-'));
    tempDirs.push(outputDir);
    const bundlePath = join(outputDir, 'index.cjs');
    await build({
      entryPoints: [join(import.meta.dirname, 'fixtures/bundled-copilot-entry.ts')],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      define: { 'import.meta.url': 'importMetaUrl' },
      inject: [join(import.meta.dirname, '../src/import-meta-url.js')],
      outfile: bundlePath,
    });
    const stdout = execFileSync(process.execPath, [bundlePath], {
      cwd: outputDir,
      encoding: 'utf8',
      env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: outputDir },
    });
    expect(JSON.parse(stdout)).toEqual({
      exchanges: 2,
      baseUrl: 'https://api.business.githubcopilot.com',
      renewed: true,
      masked: true,
    });
  });
});
