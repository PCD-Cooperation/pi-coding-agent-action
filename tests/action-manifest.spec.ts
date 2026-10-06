import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, YAMLParseError } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Validates the GitHub Action manifest (`action.yml`).
 *
 * The GitHub Actions runner uses a strict YAML parser to load the action
 * manifest; a single malformed scalar (e.g. an unescaped `'` inside a
 * single-quoted string) breaks the whole action before it ever runs.
 * This test catches such regressions in CI and in the pre-commit hook.
 */
describe('action.yml manifest', () => {
  const manifestPath = join(__dirname, '..', 'action.yml');
  let manifest: Record<string, unknown>;

  it('is valid YAML', () => {
    expect(() => {
      manifest = parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    }).not.toThrow(YAMLParseError);
    expect(manifest).toBeDefined();
  });

  it('has the required top-level sections as mappings', () => {
    for (const key of ['name', 'description', 'runs']) {
      expect(manifest[key], `missing top-level key: ${key}`).toBeDefined();
    }
    expect(manifest.runs).toBeTypeOf('object');
  });

  it('declares a node24 main entry point', () => {
    const runs = manifest.runs as Record<string, unknown>;
    expect(runs.using).toBe('node24');
    expect(runs.main).toBeTypeOf('string');
    expect(runs.main).toMatch(/dist[\\/]index\.js$/);
  });

  it('declares every input with a description', () => {
    const inputs = manifest.inputs as Record<string, { description?: string }> | undefined;
    expect(inputs).toBeTypeOf('object');
    for (const [name, input] of Object.entries(inputs ?? {})) {
      expect(input?.description, `input "${name}" has no description`).toBeTypeOf('string');
      expect(input?.description?.length).toBeGreaterThan(0);
    }
  });

  it('declares every output with a description', () => {
    const outputs = manifest.outputs as
      Record<string, { description?: string; value?: string }> | undefined;
    for (const [name, output] of Object.entries(outputs ?? {})) {
      expect(output?.description, `output "${name}" has no description`).toBeTypeOf('string');
    }
  });
});
