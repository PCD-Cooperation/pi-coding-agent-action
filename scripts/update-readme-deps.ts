import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import prettier from 'prettier';
import {
  buildDepInfos,
  buildReadmeSection,
  buildSdkBadge,
  resolvePiSdkVersion,
  spliceReadmeSection,
  spliceSdkBadge,
} from './readme-deps';

// Root scripts run as CJS under tsx, so import.meta is unavailable.
const scriptDir = dirname(resolve(process.argv[1] ?? '.'));
const REPO_ROOT = join(scriptDir, '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

async function main(): Promise<void> {
  if (!existsSync(README_PATH)) {
    console.error(`README not found at ${README_PATH}`);
    process.exit(1);
  }

  const deps = buildDepInfos(PACKAGES_DIR);
  const piSdkVersion = resolvePiSdkVersion(PACKAGES_DIR);
  const section = buildReadmeSection(deps, piSdkVersion);

  const readme = readFileSync(README_PATH, 'utf-8');
  const updated = spliceSdkBadge(
    spliceReadmeSection(readme, section),
    buildSdkBadge(piSdkVersion ?? 'unknown')
  );

  const formatted = await prettier.format(updated, {
    ...(await prettier.resolveConfig(README_PATH)),
    filepath: README_PATH,
  });
  writeFileSync(README_PATH, formatted);

  console.info('README dependency section updated successfully.');
  console.info(`Pi SDK v${piSdkVersion ?? 'unknown'}`);
  console.info(deps.map(d => `  ${d.name}@${d.version}`).join('\n'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
