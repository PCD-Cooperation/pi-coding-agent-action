import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDepInfos,
  buildReadmeSection,
  buildSdkBadge,
  collectDeclaredDeps,
  depDescription,
  npmPackageUrl,
  PI_SDK_PACKAGE,
  resolveDepVersion,
  resolveInstalledPackagePath,
  resolvePiSdkVersion,
  spliceReadmeSection,
  spliceSdkBadge,
} from '../readme-deps';

describe('npmPackageUrl', () => {
  it('encodes scoped package names', () => {
    expect(npmPackageUrl('@earendil-works/pi-coding-agent')).toBe(
      'https://www.npmjs.com/package/@earendil-works/pi-coding-agent'
    );
  });
});

describe('depDescription', () => {
  it('returns the known description for Pi SDK', () => {
    expect(depDescription(PI_SDK_PACKAGE)).toContain('Pi SDK');
  });

  it('returns empty string for unknown deps', () => {
    expect(depDescription('some-unknown-pkg')).toBe('');
  });
});

describe('collectDeclaredDeps', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'readme-deps-'));
    writePkg(dir, 'pi-action', {
      dependencies: { '@earendil-works/pi-coding-agent': 'workspace:*', leftpad: '^1.0.0' },
    });
    writePkg(dir, 'pi-coding-agent', {
      dependencies: { '@earendil-works/pi-coding-agent': '^1.0.4', typebox: '~2.0.0' },
    });
    writePkg(dir, 'pi-orchestrator-tests-only', {
      peerDependencies: { somepeer: '^0.1.0' },
    });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePkg(
    root: string,
    name: string,
    deps: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
  ): void {
    const pkgDir = join(root, name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, ...deps }));
  }

  it('merges workspace deps recursively and skips duplicates', () => {
    const deps = collectDeclaredDeps(dir, 'pi-action');
    expect(deps.get('@earendil-works/pi-coding-agent')?.spec).toBe('^1.0.4');
    expect(deps.get('@earendil-works/pi-coding-agent')?.ownerDir).toBe(
      join(dir, 'pi-coding-agent')
    );
    expect(deps.get('typebox')?.spec).toBe('~2.0.0');
    expect(deps.get('leftpad')?.spec).toBe('^1.0.0');
    expect(deps.has('somepeer')).toBe(false);
  });

  it('throws when the entry-point package is missing', () => {
    expect(() => collectDeclaredDeps(dir, 'nope')).toThrow();
  });
});

describe('resolveInstalledPackagePath', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'readme-deps-res-'));
    const owner = join(dir, 'owner');
    mkdirSync(join(owner, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(owner, 'node_modules', 'dep', 'package.json'), '{"version":"9.9.9"}');
    writeFileSync(join(owner, 'package.json'), '{}');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the installed copy from the owning package dir', () => {
    const p = resolveInstalledPackagePath('dep', join(dir, 'owner'));
    expect(p).toBe(join(dir, 'owner', 'node_modules', 'dep', 'package.json'));
  });

  it('walks up node_modules levels from the owner dir', () => {
    const nested = join(dir, 'owner', 'nested', 'deeper');
    mkdirSync(nested, { recursive: true });
    const p = resolveInstalledPackagePath('dep', nested);
    expect(p).toBe(join(dir, 'owner', 'node_modules', 'dep', 'package.json'));
  });

  it('returns undefined for uninstalled deps', () => {
    expect(resolveInstalledPackagePath('nope', join(dir, 'owner'))).toBeUndefined();
  });
});

describe('resolveDepVersion', () => {
  it('prefers the installed version over the declared spec', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readme-deps-installed-'));
    try {
      const path = join(dir, 'package.json');
      writeFileSync(path, JSON.stringify({ version: '1.2.3-beta.1' }));
      expect(resolveDepVersion(PI_SDK_PACKAGE, '^1.0.4', () => path)).toEqual({
        version: '1.2.3-beta.1',
        resolved: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the cleaned declared spec when unresolvable', () => {
    const result = resolveDepVersion('missing-pkg', '^1.2.3', () => undefined);
    expect(result).toEqual({ version: '1.2.3', resolved: false });
  });

  it('falls back when the resolved package.json is unreadable', () => {
    const result = resolveDepVersion('broken-pkg', '~2.0.0', () => '/nonexistent/package.json');
    expect(result).toEqual({ version: '2.0.0', resolved: false });
  });

  it('falls back when the resolved package.json has no version field', () => {
    const missingVersion = mkdtempSync(join(tmpdir(), 'readme-deps-nv-'));
    try {
      const pkgPath = join(missingVersion, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({ name: 'noversion' }));
      const result = resolveDepVersion('noversion', '^3.1.4', () => pkgPath);
      expect(result).toEqual({ version: '3.1.4', resolved: false });
    } finally {
      rmSync(missingVersion, { recursive: true, force: true });
    }
  });
});

describe('buildDepInfos', () => {
  it('resolves installed versions from owning packages and sorts by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readme-deps-infos-'));
    try {
      const owner = join(dir, 'pi-action');
      mkdirSync(join(owner, 'node_modules', PI_SDK_PACKAGE), { recursive: true });
      writeFileSync(
        join(owner, 'package.json'),
        JSON.stringify({ dependencies: { zzz: '~2.0.0', [PI_SDK_PACKAGE]: '^1.0.4' } })
      );
      writeFileSync(
        join(owner, 'node_modules', PI_SDK_PACKAGE, 'package.json'),
        JSON.stringify({ version: '1.2.3' })
      );
      const infos = buildDepInfos(dir);
      expect(infos.map(i => i.name)).toEqual([PI_SDK_PACKAGE, 'zzz']);
      expect(infos.map(i => i.version)).toEqual(['1.2.3', '2.0.0']);
      expect(resolvePiSdkVersion(dir)).toBe('1.2.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildReadmeSection', () => {
  const deps = [
    { name: 'b-pkg', version: '2.0.0', description: 'B' },
    { name: 'a-pkg', version: '1.0.0', description: 'A' },
  ];

  it('includes the Pi SDK summary line when a version is available', () => {
    const section = buildReadmeSection(deps, '1.0.4');
    expect(section).toContain('Pi SDK');
    expect(section).toContain('**v1.0.4**');
    expect(section).toContain('issue-comment reports');
    expect(section).toContain('| `a-pkg` | `1.0.0` | A |');
  });

  it('omits the summary line for unknown/absent versions', () => {
    expect(buildReadmeSection(deps, undefined)).not.toContain('Pi SDK');
    expect(buildReadmeSection(deps, 'unknown')).not.toContain('**v');
  });
});

describe('buildSdkBadge / spliceSdkBadge', () => {
  const header = [
    '<p align="center">',
    '  <!-- PI_SDK_BADGE_START -->',
    '  <a href="old"><img alt="old"></a>',
    '  <!-- PI_SDK_BADGE_END -->',
    '</p>',
  ].join('\n');

  it('embeds the resolved version statically (not the npm latest)', () => {
    const badge = buildSdkBadge('1.2.3');
    expect(badge).toContain('Pi%20SDK-v1.2.3');
    expect(badge).toContain('npmjs.com/package/@earendil-works/pi-coding-agent');
  });

  it('replaces the badge between the markers', () => {
    const updated = spliceSdkBadge(header, buildSdkBadge('1.2.3'));
    expect(updated).toContain('Pi%20SDK-v1.2.3');
    expect(updated).not.toContain('href="old"');
    expect(updated).toContain('<!-- PI_SDK_BADGE_START -->');
    expect(updated).toContain('<!-- PI_SDK_BADGE_END -->');
  });

  it('throws when badge markers are missing', () => {
    expect(() => spliceSdkBadge('no markers', buildSdkBadge('1.2.3'))).toThrow(/missing/);
  });
});

describe('resolvePiSdkVersion', () => {
  it('returns undefined when the SDK is not a declared dep', () => {
    const empty = mkdtempSync(join(tmpdir(), 'readme-deps-empty-'));
    try {
      mkdirSync(join(empty, 'pi-action'), { recursive: true });
      writeFileSync(
        join(empty, 'pi-action', 'package.json'),
        JSON.stringify({ name: 'pi-action', dependencies: { other: '^1.0.0' } })
      );
      expect(resolvePiSdkVersion(empty)).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('spliceReadmeSection', () => {
  const readme = [
    'before',
    '<!-- DEPS_TABLE_START -->',
    'old content',
    '<!-- DEPS_TABLE_END -->',
    'after',
  ].join('\n');

  it('replaces content between the markers', () => {
    const updated = spliceReadmeSection(readme, 'NEW');
    expect(updated).toBe(
      [
        'before',
        '<!-- DEPS_TABLE_START -->',
        '',
        'NEW',
        '',
        '<!-- DEPS_TABLE_END -->',
        'after',
      ].join('\n')
    );
  });

  it('throws when markers are missing', () => {
    expect(() => spliceReadmeSection('no markers', 'NEW')).toThrow(/missing/);
  });
});
