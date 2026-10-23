import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PI_SDK_PACKAGE } from '../packages/pi-action/scripts/pi-sdk';

export { PI_SDK_PACKAGE };

const MARKER_START = '<!-- DEPS_TABLE_START -->';
const MARKER_END = '<!-- DEPS_TABLE_END -->';

const BADGE_MARKER_START = '<!-- PI_SDK_BADGE_START -->';
const BADGE_MARKER_END = '<!-- PI_SDK_BADGE_END -->';

export function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

export interface DepInfo {
  name: string;
  version: string;
  description: string;
}

const DEP_DESCRIPTIONS: Record<string, string> = {
  '@actions/core': 'GitHub Actions core I/O (inputs, outputs, logging)',
  '@actions/github': 'GitHub API client (Octokit wrapper)',
  '@earendil-works/pi-agent-core': 'Pi Agent Core — agent orchestration primitives',
  '@earendil-works/pi-ai': 'Pi AI — AI model abstractions and providers',
  '@earendil-works/pi-coding-agent': 'Pi SDK — AI coding agent runtime',
  '@js-temporal/polyfill': 'Temporal API polyfill',
  '@octokit/core': 'Octokit REST API client core',
  '@octokit/plugin-rest-endpoint-methods': 'Octokit REST API endpoint methods',
  ignore: '`.gitignore`-style pattern matching',
  typebox: 'JSON Schema Type Builder',
};

export function depDescription(name: string): string {
  return DEP_DESCRIPTIONS[name] ?? '';
}

function isWorkspaceSpec(spec: string): boolean {
  return /^workspace:/.test(spec);
}

function cleanVersion(spec: string): string {
  return spec
    .replace(/^[=~^<>]?=?\s*/, '')
    .replace(/-.*$/, '')
    .trim();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

interface PkgJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface DepEntry {
  spec: string;
  ownerDir: string;
}

export function collectDeclaredDeps(
  packagesDir: string,
  entryPointPkg = 'pi-action'
): Map<string, DepEntry> {
  const entryPkgPath = join(packagesDir, entryPointPkg, 'package.json');
  if (!existsSync(entryPkgPath)) {
    throw new Error(`Entry-point package not found at ${entryPkgPath}`);
  }

  const merged = new Map<string, DepEntry>();
  const visited = new Set<string>();

  function resolvePackage(pkgDirName: string): void {
    const pkgJsonPath = join(packagesDir, pkgDirName, 'package.json');
    if (!existsSync(pkgJsonPath) || visited.has(pkgDirName)) {
      return;
    }
    visited.add(pkgDirName);
    const pkgDir = dirname(pkgJsonPath);

    const pkg = readJson(pkgJsonPath) as PkgJson;

    const allDeps: Record<string, string> = {
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.dependencies ?? {}),
    };

    for (const [name, spec] of Object.entries(allDeps)) {
      if (isWorkspaceSpec(spec)) {
        const targetDir = name.startsWith('@') ? name.split('/').pop()! : name;
        resolvePackage(targetDir);
      } else if (!merged.has(name)) {
        merged.set(name, { spec, ownerDir: pkgDir });
      }
    }
  }

  resolvePackage(entryPointPkg);
  return merged;
}

export function resolveInstalledPackagePath(pkgName: string, ownerDir: string): string | undefined {
  let dir = ownerDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', pkgName, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function resolveDepVersion(
  name: string,
  declaredSpec: string,
  resolvePath: (pkgName: string) => string | undefined = () => undefined
): { version: string; resolved: boolean } {
  const pkgJsonPath = resolvePath(name);
  if (pkgJsonPath) {
    try {
      const v = (readJson(pkgJsonPath) as { version?: string }).version;
      if (v) {
        return { version: v, resolved: true };
      }
    } catch {
      // fall through to declared spec
    }
  }
  return { version: cleanVersion(declaredSpec), resolved: false };
}

export function buildReadmeSection(deps: DepInfo[], piSdkVersion: string | undefined): string {
  const header = `| Dependency | Version | Description |`;
  const separator = `|---|---|---|`;
  const rows = deps.map(d => `| \`${d.name}\` | \`${d.version}\` | ${d.description} |`);
  const table = [header, separator, ...rows].join('\n');

  if (piSdkVersion && piSdkVersion !== 'unknown') {
    const summary =
      `This build bundles the [Pi SDK](${npmPackageUrl(PI_SDK_PACKAGE)}) ` +
      `(\`${PI_SDK_PACKAGE}\`) **v${piSdkVersion}** — the same version stamped ` +
      `on the action's issue-comment reports.`;
    return `${summary}\n\n${table}`;
  }
  return table;
}

export function spliceReadmeSection(readme: string, section: string): string {
  const startIdx = readme.indexOf(MARKER_START);
  const endIdx = readme.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md is missing ${MARKER_START} and/or ${MARKER_END} markers`);
  }

  return (
    readme.slice(0, startIdx + MARKER_START.length) +
    '\n\n' +
    section +
    '\n\n' +
    readme.slice(endIdx)
  );
}

export function resolvePiSdkVersion(packagesDir: string): string | undefined {
  const declared = collectDeclaredDeps(packagesDir);
  const entry = declared.get(PI_SDK_PACKAGE);
  if (!entry) {
    return undefined;
  }
  const { version, resolved } = resolveDepVersion(PI_SDK_PACKAGE, entry.spec, name =>
    resolveInstalledPackagePath(name, entry.ownerDir)
  );
  return resolved ? version : undefined;
}

export function buildSdkBadge(piSdkVersion: string): string {
  const label = `Pi%20SDK-v${piSdkVersion}`;
  const badge =
    `<a href="${npmPackageUrl(PI_SDK_PACKAGE)}">` +
    `<img alt="Pi SDK v${piSdkVersion}" src="https://img.shields.io/badge/${label}-2C8EBB?logo=pi">` +
    `</a>`;
  return badge;
}

export function spliceSdkBadge(readme: string, badge: string): string {
  const startIdx = readme.indexOf(BADGE_MARKER_START);
  const endIdx = readme.indexOf(BADGE_MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `README.md is missing ${BADGE_MARKER_START} and/or ${BADGE_MARKER_END} markers`
    );
  }

  return (
    readme.slice(0, startIdx + BADGE_MARKER_START.length) +
    '\n  ' +
    badge +
    '\n  ' +
    readme.slice(endIdx)
  );
}

export function buildDepInfos(
  packagesDir: string,
  resolvePath: (
    pkgName: string,
    ownerDir: string
  ) => string | undefined = resolveInstalledPackagePath
): DepInfo[] {
  const declared = collectDeclaredDeps(packagesDir);
  return Array.from(declared.entries())
    .map(([name, entry]) => {
      const { version } = resolveDepVersion(name, entry.spec, pkgName =>
        resolvePath(pkgName, entry.ownerDir)
      );
      return { name, version, description: depDescription(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
