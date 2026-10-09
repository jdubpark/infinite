#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = await build({ entryPoints: [join(repository, 'packages/host/dist/client-entry.js')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', banner: { js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);' } });
const files = [
  { name: 'client-entry.js', contents: Buffer.from(bundle.outputFiles[0].contents) },
  { name: 'workspace-watch.c', contents: readFileSync(join(repository, 'scripts/native/workspace-watch.c')) },
];
const revision = createHash('sha256').update(Buffer.concat(files.map(f => f.contents))).digest('hex').slice(0, 16);
const parent = join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/Infinite/cli' : '.local/share/infinite/cli');
const runtime = join(parent, revision), bin = join(homedir(), '.local/bin'), command = join(bin, 'infinite');
if (existsSync(command) && (!lstatSync(command).isSymbolicLink() || !readlinkSync(command).startsWith(parent + '/'))) throw new Error('An unmanaged ~/.local/bin/infinite already exists; it was not changed');
mkdirSync(runtime, { recursive: true, mode: 0o700 });
for (const file of files) writeFileSync(join(runtime, file.name), file.contents, { mode: 0o600 });
writeFileSync(join(runtime, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
chmodSync(join(runtime, 'client-entry.js'), 0o700);
mkdirSync(bin, { recursive: true });
const temporary = command + '.' + randomUUID();
symlinkSync(join(runtime, 'client-entry.js'), temporary); renameSync(temporary, command);
console.log(`Installed ${command}\nRuntime: ${runtime}`);
if (!process.env.PATH?.split(':').includes(bin)) console.log(`Add ${bin} to PATH to run infinite from any terminal.`);
