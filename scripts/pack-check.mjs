// Packs every workspace package the way `pnpm publish` would, then lints each
// tarball with publint and @arethetypeswrong/cli. Expects `dist/` to be built.
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packages = readdirSync('packages');
const packDir = resolve('node_modules', '.cache', 'pack-check');

function run(command, ...paths) {
  execSync([command, ...paths.map((path) => JSON.stringify(path))].join(' '), {
    stdio: 'inherit',
  });
}

rmSync(packDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });

run('pnpm --filter "./packages/*" pack --pack-destination', packDir);

const tarballs = readdirSync(packDir).filter((file) => file.endsWith('.tgz'));
if (tarballs.length !== packages.length) {
  throw new Error(`Expected ${packages.length} tarballs in ${packDir}, found ${tarballs.length}`);
}

for (const tarball of tarballs) {
  const file = join(packDir, tarball);
  run('pnpm exec publint run --strict', file);
  run('pnpm exec attw --profile esm-only', file);
}
