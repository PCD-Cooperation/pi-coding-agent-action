import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const checkOnly = process.argv.includes('--check');

const SYNCED_SCOPE = '@earendil-works';
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const rootPkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = rootPkg.version;

const syncedDeps: Record<string, string> = Object.fromEntries(
  Object.entries<string>({
    ...(rootPkg.devDependencies ?? {}),
    ...(rootPkg.dependencies ?? {}),
  }).filter(([name]) => name.startsWith(`${SYNCED_SCOPE}/`))
);

const packages = readdirSync('packages', { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let drifted = false;

for (const pkg of packages) {
  const path = join('packages', pkg, 'package.json');
  const pkgJson = JSON.parse(readFileSync(path, 'utf-8'));
  let changed = false;

  const report = (message: string): void => {
    if (checkOnly) drifted = true;
    console.info(message);
  };

  if (pkgJson.version !== version) {
    report(`↑ ${pkg} version → v${version}`);
    if (!checkOnly) {
      pkgJson.version = version;
      changed = true;
    }
  } else {
    console.info(`✓ ${pkg} version already at v${version}`);
  }

  for (const field of DEP_FIELDS) {
    const deps: Record<string, string> | undefined = pkgJson[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (!(name in syncedDeps)) continue;
      const current = deps[name]!;
      const target = syncedDeps[name]!;
      if (current === target) {
        console.info(`✓ ${pkg} ${field}.${name} already at ${target}`);
        continue;
      }
      report(`↑ ${pkg} ${field}.${name} ${current} → ${target}`);
      if (checkOnly) continue;
      deps[name] = target;
      changed = true;
    }
  }

  if (changed && !checkOnly) {
    writeFileSync(path, JSON.stringify(pkgJson, null, 2) + '\n');
  }
}

if (checkOnly && drifted) {
  console.error(
    '\n✗ Dependency/version drift detected. Run `pnpm run sync-versions` and commit the result.'
  );
  process.exit(1);
}
