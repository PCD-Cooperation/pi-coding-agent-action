/**
 * @file Tests for {@link packages/pi-action-bridge/src/git.ts}.
 *
 * Covers the two helpers not exercised through the orchestration tests:
 *   - `shouldIsolateGitConfig` — the conditional git-config isolation policy
 *     (all decision branches, deterministically, via an injected `access` probe
 *     so the sandbox `EACCES` path doesn't depend on OS file perms / root).
 *   - `pickRemote` — `origin` preference + first-available fallback + empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitInspector, shouldIsolateGitConfig, pickRemote } from '../src/git.js';
import type { RemoteWithRefs } from 'simple-git';

/** A probe that always reports the file as readable (no throw). */
const readable = (): void => undefined;

/** Build a probe that throws with the given errno `code`. */
const throws =
  (code: string): ((path: string) => void) =>
  () => {
    const err: NodeJS.ErrnoException = new Error(`probe: ${code}`);
    err.code = code;
    throw err;
  };

describe('shouldIsolateGitConfig', () => {
  it('does not isolate when ~/.gitconfig is readable (local TUI)', () => {
    expect(shouldIsolateGitConfig({ HOME: '/home/user' }, readable)).toBe(false);
  });

  it('isolates when ~/.gitconfig exists but is unreadable (sandbox EACCES)', () => {
    expect(shouldIsolateGitConfig({ HOME: '/home/user' }, throws('EACCES'))).toBe(true);
  });

  it('also isolates on EPERM ("Operation not permitted")', () => {
    expect(shouldIsolateGitConfig({ HOME: '/home/user' }, throws('EPERM'))).toBe(true);
  });

  it('does not isolate when ~/.gitconfig is simply absent (ENOENT)', () => {
    // A missing global gitconfig is benign — git tolerates it, so the system
    // config is not dropped unnecessarily.
    expect(shouldIsolateGitConfig({ HOME: '/home/user' }, throws('ENOENT'))).toBe(false);
  });

  it('respects an explicit GIT_CONFIG_GLOBAL already in the env', () => {
    // User/CI set their own — never override, regardless of readability.
    expect(
      shouldIsolateGitConfig({ HOME: '/home/user', GIT_CONFIG_GLOBAL: '/x' }, throws('EACCES'))
    ).toBe(false);
  });

  it('does not isolate when HOME is unset', () => {
    expect(shouldIsolateGitConfig({}, readable)).toBe(false);
  });

  // Real-filesystem integration: confirms the default probe resolves an actual
  // readable gitconfig / an absent one correctly (no injected access fn).
  describe('with the real default probe (default accessSync)', () => {
    let home: string;
    const savedHome = process.env.HOME;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'bridge-git-'));
      process.env.HOME = home;
    });

    afterEach(() => {
      process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    });

    it('returns false when a readable ~/.gitconfig exists', () => {
      writeFileSync(join(home, '.gitconfig'), '[user]\n');
      expect(shouldIsolateGitConfig(process.env)).toBe(false);
    });

    it('returns false when ~/.gitconfig is absent', () => {
      expect(shouldIsolateGitConfig(process.env)).toBe(false);
    });
  });
});

describe('createGitInspector environment compatibility', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'bridge-inspector-'));
    vi.stubEnv('HOME', cwd);
    vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'forge:owner/repo.git'], {
      cwd,
      stdio: 'pipe',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('preserves readable local user config and URL rewrites', async () => {
    writeFileSync(
      join(cwd, '.gitconfig'),
      '[url "https://forgejo.example.test/"]\ninsteadOf = forge:\n'
    );
    const inspector = createGitInspector(cwd);
    expect((await inspector.getRemotes())[0]?.refs.fetch).toBe(
      'https://forgejo.example.test/owner/repo.git'
    );
  });

  it('respects an explicit global config override', async () => {
    const config = join(cwd, 'custom.gitconfig');
    writeFileSync(config, '[url "https://custom.example.test/"]\ninsteadOf = forge:\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    const inspector = createGitInspector(cwd, process.env, throws('EACCES'));
    expect((await inspector.getRemotes())[0]?.refs.fetch).toBe(
      'https://custom.example.test/owner/repo.git'
    );
  });

  it('isolates unreadable config without forwarding unrelated ambient GIT_* values', async () => {
    writeFileSync(join(cwd, '.gitconfig'), 'invalid git config');
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -v');
    vi.stubEnv('GIT_DIR', join(cwd, 'nonexistent.git'));
    const inspector = createGitInspector(cwd, process.env, throws('EACCES'));
    await expect(inspector.isRepo()).resolves.toBe(true);
    await expect(inspector.status()).resolves.toMatchObject({ files: expect.any(Array) });
    expect((await inspector.getRemotes())[0]?.refs.fetch).toBe('forge:owner/repo.git');
  });

  it('filters unrelated ambient GIT_* values without isolating readable config', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -v');
    vi.stubEnv('GIT_DIR', join(cwd, 'nonexistent.git'));
    await expect(createGitInspector(cwd).isRepo()).resolves.toBe(true);
  });
});

describe('pickRemote', () => {
  function remote(name: string, url = `git@github.com:o/${name}.git`): RemoteWithRefs {
    return { name, refs: { fetch: url, push: url } };
  }

  it('prefers origin when present', () => {
    const remotes = [remote('upstream'), remote('origin'), remote('fork')];
    expect(pickRemote(remotes)?.name).toBe('origin');
  });

  it('prefers origin regardless of position', () => {
    const remotes = [remote('origin'), remote('upstream')];
    expect(pickRemote(remotes)?.name).toBe('origin');
  });

  it('falls back to the first remote when there is no origin', () => {
    const remotes = [remote('upstream'), remote('fork')];
    expect(pickRemote(remotes)?.name).toBe('upstream');
  });

  it('returns undefined when there are no remotes', () => {
    expect(pickRemote([])).toBeUndefined();
  });
});
