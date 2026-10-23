import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const cli = require.resolve('tsx/cli');
const script = fileURLToPath(new URL('../sync-versions.ts', import.meta.url));
const sdk = '@earendil-works/pi-coding-agent';
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

describe('sync-versions CLI', () => {
  let dir: string;
  let packagePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-versions-'));
    packagePath = join(dir, 'packages', 'example', 'package.json');
    mkdirSync(join(dir, 'packages', 'example'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        version: '2.0.0',
        dependencies: { [sdk]: '^1.2.3', unrelated: '^2.0.0' },
        devDependencies: { [sdk]: '^0.0.1', '@earendil-works/pi-ai': '~1.2.3' },
      })
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, script, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
    });
  }

  function writePackage(version: string, spec: string): void {
    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'example',
        version,
        ...Object.fromEntries(
          fields.map(field => [
            field,
            { [sdk]: spec, '@earendil-works/pi-ai': '~1.2.3', unrelated: '^1.0.0' },
          ])
        ),
      })
    );
  }

  it('passes --check without rewriting synchronized files', () => {
    writePackage('2.0.0', '^1.2.3');
    const before = readFileSync(packagePath, 'utf-8');
    const result = run('--check');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(packagePath, 'utf-8')).toBe(before);
  });

  it.each([
    ['package version', '1.0.0', '^1.2.3'],
    ['SDK dependency', '2.0.0', '^0.0.1'],
    ['both', '1.0.0', '^0.0.1'],
  ])('reports %s drift without modifying any manifest', (_, version, spec) => {
    writePackage(version, spec);
    const rootBefore = readFileSync(join(dir, 'package.json'), 'utf-8');
    const before = readFileSync(packagePath, 'utf-8');
    const result = run('--', '--check');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Dependency/version drift detected');
    expect(readFileSync(packagePath, 'utf-8')).toBe(before);
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).toBe(rootBefore);
  });

  it('propagates root versions to all dependency fields, including peers', () => {
    writePackage('1.0.0', '^0.0.1');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    pkg.devDependencies['@earendil-works/pi-ai'] = '^0.0.1';
    pkg.peerDependencies['@earendil-works/not-in-root'] = '^9.0.0';
    writeFileSync(packagePath, JSON.stringify(pkg));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const updated = JSON.parse(readFileSync(packagePath, 'utf-8'));
    expect(updated.version).toBe('2.0.0');
    for (const field of fields) {
      expect(updated[field][sdk]).toBe('^1.2.3');
      expect(updated[field]['@earendil-works/pi-ai']).toBe('~1.2.3');
      expect(updated[field].unrelated).toBe('^1.0.0');
    }
    expect(updated.peerDependencies['@earendil-works/not-in-root']).toBe('^9.0.0');
    expect(run('--check').status).toBe(0);
  });
});
