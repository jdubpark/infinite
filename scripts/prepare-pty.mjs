import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, statSync, chmodSync } from 'node:fs';

// node-pty 1.1.0's npm archive ships the macOS spawn helper without execute
// permission. Repair that package file on clean installs, before launching PTYs.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) {
    const mode = statSync(helper).mode;
    if (!(mode & 0o100)) chmodSync(helper, mode | 0o111);
  }
}
