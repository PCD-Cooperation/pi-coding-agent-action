/**
 * @file Pure version-composition + provenance helpers.
 *
 * Shared by the esbuild bundler (`packages/pi-action/scripts/package.ts`), the
 * CI dist-rebuild workflow, and unit tests. Kept dependency-free (the only I/O
 * is a caller-supplied `readFileSync` of a JSON path) so it is trivially
 * testable and cheap to load — never import esbuild from here.
 *
 * ## Version scheme
 *
 * - **Release builds** (built from a release branch like `v2`, or with
 *   `PI_ACTION_RELEASE_BUILD=true`): bare semver, e.g. `2.19.3`
 * - **Development builds** (built from any other branch):
 *   `<base>-<branch>.<sha>`, e.g. `2.19.3-develop.9272858`
 * - **Local builds** (no CI env vars):
 *   `<base>-unknown.unknown`, e.g. `2.19.3-unknown.unknown`
 *
 * The suffix lives in the semver **prerelease** slot (`-`) so that
 * `2.19.3-develop.abc < 2.19.3` (correct precedence).
 */

import { readFileSync } from 'node:fs';

/**
 * Regex matching release branches: v2, v3, v10, …
 *
 * Exported for unit testing.
 */
export const RELEASE_BRANCH_RE = /^v\d+$/;

/**
 * Resolve branch name from the GitHub-native `GITHUB_REF_NAME` env var,
 * falling back to `'unknown'` when not running in CI.
 */
export function resolveBranch(): string {
  return process.env.GITHUB_REF_NAME ?? 'unknown';
}

/**
 * Resolve short (7-char) commit SHA from the GitHub-native `GITHUB_SHA` env
 * var, falling back to `'unknown'` when not running in CI.
 */
export function resolveSha(): string {
  return (process.env.GITHUB_SHA ?? 'unknown').slice(0, 7);
}

/**
 * Sanitize a string for use in semver prerelease identifiers.
 *
 * Semver prerelease identifiers allow only `[0-9A-Za-z-]` plus `.` separators.
 * Characters like `/` in branch names (e.g. `feature/foo`) are replaced with `-`.
 */
export function sanitizeSemverIdent(ident: string): string {
  return ident.replace(/[^0-9A-Za-z-]/g, '-');
}

/**
 * Compose the action version string from the base version and ambient
 * GitHub-native env vars.
 *
 * - **Release build** (`PI_ACTION_RELEASE_BUILD=true`, or `GITHUB_REF_NAME`
 *   matches `/^v\d+$/`): bare semver, e.g. `2.19.3`.
 * - **Any other build**: `<base>-<branch>.<sha>` (semver prerelease),
 *   e.g. `2.19.3-develop.9272858`.
 * - **No env vars** (local build): `<base>-unknown.unknown`.
 *
 * Exported for unit testing.
 */
export function composeActionVersion(
  baseVersion: string,
  branch: string = resolveBranch(),
  sha: string = resolveSha(),
  releaseBuild: boolean = process.env.PI_ACTION_RELEASE_BUILD === 'true'
): string {
  if (releaseBuild || RELEASE_BRANCH_RE.test(branch)) {
    return baseVersion;
  }
  return `${baseVersion}-${sanitizeSemverIdent(branch)}.${sanitizeSemverIdent(sha)}`;
}

/**
 * Read the `version` field from a JSON file at `path`. Throws if the file
 * is missing, unreadable, or its JSON lacks a `version` field.
 *
 * Exported for unit testing.
 */
export function readJsonVersion(path: string): string {
  return JSON.parse(readFileSync(path, 'utf-8')).version;
}

// ---------------------------------------------------------------------------
// Dist rebuild provenance
// ---------------------------------------------------------------------------

/** Structured provenance for a `dist/` build, used to compose the commit message. */
export interface DistBuildProvenance {
  /** Composed version, e.g. `2.20.1-develop.9272858` (release branch → bare semver). */
  fullVersion: string;
  /** Git branch the build ran on, e.g. `develop`. */
  branch: string;
  /** Full source commit SHA (or `'unknown'`). */
  sourceSha: string;
  /** Pi SDK version bundled into the dist, e.g. `0.79.4`. */
  piSdkVersion: string;
}

/**
 * Compose the structured, non-releasable commit message used when landing a
 * rebuilt `dist/`.
 *
 * The `chore(dist)` scope is deliberately a non-releasable type for
 * `@semantic-release/commit-analyzer` (it will never itself trigger a release),
 * and `[skip ci]` prevents the push from retriggering the develop pipeline.
 *
 * The body records the exact source SHA, branch, and bundled Pi SDK version so
 * that `git log -- dist/` alone reconstructs the build provenance.
 *
 * Exported for unit testing.
 */
export function composeDistCommitMessage(p: DistBuildProvenance): string {
  return [
    `chore(dist): rebuild ${p.fullVersion} [skip ci]`,
    '',
    `source:   ${p.sourceSha}`,
    `branch:   ${p.branch}`,
    `pi-sdk:   ${p.piSdkVersion}`,
  ].join('\n');
}
