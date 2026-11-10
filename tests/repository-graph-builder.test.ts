import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = path.join(root, 'scripts', 'repository_graph.py');

const fakeGraphify = String.raw`#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys, time
if sys.argv[1:] == ['--version']:
    print('graphify test-double 1')
    raise SystemExit(0)
cmd = sys.argv[1]
if cmd == 'cluster-only':
    raise SystemExit(0)
source = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[sys.argv.index('--out') + 1]) / 'graphify-out'
out.mkdir(parents=True, exist_ok=True)
if os.environ.get('FAKE_DELAY'):
    marker = os.environ.get('FAKE_CHILD_MARKER')
    pid_file = os.environ.get('FAKE_CHILD_PID_FILE')
    if marker and pid_file:
        child = subprocess.Popen([sys.executable, '-c', 'import pathlib,sys,time; time.sleep(0.9); pathlib.Path(sys.argv[1]).write_text("survived")', marker])
        pathlib.Path(pid_file).write_text(str(child.pid))
    time.sleep(float(os.environ['FAKE_DELAY']))
if os.environ.get('FAKE_FAIL'):
    print('intentional extractor failure', file=sys.stderr)
    raise SystemExit(9)
manifest_path = out / 'manifest.json'
try:
    previous = json.loads(manifest_path.read_text())
except Exception:
    previous = {}
found = {}
for p in source.rglob('*'):
    if p.is_file():
        rel = p.relative_to(source).as_posix()
        found[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
changed = sorted(k for k, v in found.items() if previous.get(k) != v)
deleted = sorted(k for k in previous if k not in found)
try:
    previous_graph = json.loads((out / 'graph.json').read_text())
except Exception:
    previous_graph = {}
manifest_path.write_text(json.dumps(found))
(out / '.graphify_build.json').write_text(json.dumps({'code_only': True}))
(out / '.graphify_root').write_text(str(source.resolve()))
nodes = [{'id': str(pathlib.PurePosixPath(name).with_suffix('')).replace('/', '_'), 'source_file': name} for name in found]
links = []
if 'remove.py' in found:
    nodes.append({'id': 'remove_symbol', 'source_file': 'remove.py'})
if 'caller.py' in found and 'remove()' in (source / 'caller.py').read_text():
    links.append({'source': 'caller', 'target': 'remove_symbol', 'relation': 'calls', 'source_file': 'caller.py'})
if 'caller.py' in found and 'future_api()' in (source / 'caller.py').read_text():
    if 'api.py' in found:
        nodes.extend([{'id': 'api', 'source_file': 'api.py'}, {'id': 'api_future_api', 'source_file': 'api.py'}])
    else:
        nodes.append({'id': 'ref_api', 'source_file': '', 'external': True})
    links.append({'source': 'caller', 'target': 'ref_api' if 'api.py' not in found else 'api_future_api',
        'relation': 'calls', 'source_file': 'caller.py'})
for directory in sorted({str(pathlib.PurePosixPath(name).parent) for name in found if name.endswith('caller.ts')}):
    prefix = '' if directory == '.' else directory + '/'
    anchor = prefix.replace('/', '_')
    if (source / 'tsconfig.json').is_file():
        config = json.loads((source / 'tsconfig.json').read_text())
        provider = pathlib.Path(config['compilerOptions']['paths']['@/api'][0]).stem
    else:
        provider = 'api'
    for module in ('a', 'b', 'api', 'stable', 'caller'):
        name = prefix + module + '.ts'
        if name not in found:
            continue
        module_id = anchor + module
        nodes.append({'id': module_id, 'source_file': name})
        if module in ('a', 'b', 'api'):
            function_id = module_id + ('_future_api' if module == 'api' else '_foo')
            nodes.append({'id': function_id, 'source_file': name})
            links.append({'source': module_id, 'target': function_id, 'relation': 'contains', 'source_file': name})
        if module == 'caller':
            call_id = module_id + '_call'
            nodes.append({'id': call_id, 'source_file': name})
            links.append({'source': module_id, 'target': call_id, 'relation': 'contains', 'source_file': name})
            if name in changed or not previous_graph:
                if prefix + provider + '.ts' in found:
                    provider_id = anchor + provider
                    function_id = provider_id + ('_future_api' if provider == 'api' else '_foo')
                    links.extend([
                        {'source': module_id, 'target': provider_id, 'relation': 'imports_from', 'source_file': name},
                        {'source': module_id, 'target': function_id, 'relation': 'imports', 'source_file': name},
                        {'source': call_id, 'target': function_id, 'relation': 'calls', 'source_file': name},
                    ])
                else:
                    links.append({'source': module_id, 'target': 'ref_api', 'relation': 'imports_from', 'source_file': name})
                    nodes.append({'id': 'ref_api', 'source_file': '', 'external': True})
            else:
                links.extend(edge for edge in previous_graph.get('links', []) if edge.get('source_file') == name)
(out / 'graph.json').write_text(json.dumps({'files': sorted(found), 'graph': {'schema_version': 1}, 'nodes': nodes, 'links': links}))
with open(os.environ['FAKE_LOG'], 'a') as f:
    f.write(json.dumps({'changed': changed, 'deleted': deleted}) + '\n')
`;

async function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'repo-graph-'));
  const repo = path.join(temp, 'repo');
  const cache = path.join(temp, 'cache');
  const graphify = path.join(temp, 'graphify');
  const log = path.join(temp, 'extract-log.jsonl');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'builder@example.invalid');
  await git(repo, 'config', 'user.name', 'Builder Test');
  await writeFile(path.join(repo, 'keep.py'), 'def keep(): return 1\n');
  await writeFile(path.join(repo, 'stable.py'), 'def stable(): return 5\n');
  await writeFile(path.join(repo, 'caller.py'), 'def caller(): return remove()\n');
  await writeFile(path.join(repo, 'remove.py'), 'def remove(): return 1\n');
  await writeFile(path.join(graphify), fakeGraphify, { mode: 0o755 });
  await writeFile(log, '');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'initial');
  return { temp, repo, cache, graphify, log };
}

function run(f: Awaited<ReturnType<typeof fixture>>, extraEnv: Record<string, string> = {}, seedCache?: string, timeout = '20') {
  const args = [builder, '--repo', f.repo, '--cache-dir', f.cache,
    '--ref', 'HEAD', '--graphify', f.graphify, '--timeout-seconds', timeout];
  if (seedCache) args.push('--seed-cache-dir', seedCache);
  const result = spawnSync('python3', args, {
    encoding: 'utf8', env: { ...process.env, FAKE_LOG: f.log, ...extraEnv },
  });
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, result.stdout);
  return { code: result.status, value: JSON.parse(lines[0]!) as Record<string, any> };
}

test('builds committed snapshots incrementally and leaves the last good graph on failure', async () => {
  const f = await fixture();
  try {
    const initial = run(f);
    assert.equal(initial.code, 0, JSON.stringify(initial.value));
    assert.equal(initial.value.status, 'ready');
    assert.equal(initial.value.mode, 'initial');
    assert.equal(initial.value.changedFiles, 4);
    const firstGraph = initial.value.graphPath as string;
    const firstGeneration = path.dirname(path.dirname(path.dirname(firstGraph)));
    const originalMtime = (await stat(path.join(firstGeneration, 'source', 'keep.py'))).mtimeMs;
    const stableMtime = (await stat(path.join(firstGeneration, 'source', 'stable.py'))).mtimeMs;
    assert.equal((await readFile(path.join(firstGeneration, 'out', 'graphify-out', '.graphify_root'), 'utf8')),
      path.join(firstGeneration, 'source'));

    await writeFile(path.join(f.repo, 'keep.py'), 'def keep(): return 2\n');
    await git(f.repo, 'mv', 'remove.py', 'renamed.py');
    await writeFile(path.join(f.repo, 'added.py'), 'def added(): return 3\n');
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-qm', 'update');
    assert.notEqual(await git(f.repo, 'rev-parse', 'HEAD'), initial.value.head);
    const incremental = run(f);
    assert.equal(incremental.code, 0);
    assert.equal(incremental.value.mode, 'incremental', JSON.stringify({ result: incremental.value,
      metadata: await readFile(path.join(firstGeneration, 'metadata.json'), 'utf8'),
      manifest: await readFile(path.join(firstGeneration, 'out', 'graphify-out', 'manifest.json'), 'utf8') }));
    assert.equal(incremental.value.changedFiles, 3);
    assert.equal(incremental.value.deletedFiles, 1);
    const secondGraph = incremental.value.graphPath as string;
    const graph = JSON.parse(await readFile(secondGraph, 'utf8')) as { files: string[] };
    assert.deepEqual(graph.files, ['added.py', 'caller.py', 'keep.py', 'renamed.py', 'stable.py']);
    assert.equal((await stat(path.join(path.dirname(path.dirname(path.dirname(secondGraph))), 'source', 'keep.py'))).mtimeMs > originalMtime, true);
    assert.equal((await stat(path.join(path.dirname(path.dirname(path.dirname(secondGraph))), 'source', 'stable.py'))).mtimeMs, stableMtime);
    const extractorRuns = (await readFile(f.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(extractorRuns[1], { changed: ['added.py', 'caller.py', 'keep.py', 'renamed.py'], deleted: ['remove.py'] });
    assert.equal(incremental.value.affectedFiles, 1);
    assert.equal(await readFile(path.join(firstGeneration, 'source', 'keep.py'), 'utf8'), 'def keep(): return 1\n');
    assert.equal(await readFile(path.join(firstGeneration, 'source', 'remove.py'), 'utf8'), 'def remove(): return 1\n');
    assert.equal(await readFile(path.join(path.dirname(path.dirname(path.dirname(secondGraph))), 'out', 'graphify-out', '.graphify_root'), 'utf8'),
      path.join(path.dirname(path.dirname(path.dirname(secondGraph))), 'source'));

    const noOp = run(f);
    assert.equal(noOp.code, 0);
    assert.equal(noOp.value.status, 'unchanged');
    assert.equal(noOp.value.mode, 'unchanged');
    assert.equal((await readFile(f.log, 'utf8')).trim().split('\n').length, 2);
    assert.equal((await readFile(f.repo + '/keep.py', 'utf8')), 'def keep(): return 2\n');

    await writeFile(path.join(f.repo, 'keep.py'), 'def keep(): return 4\n');
    await git(f.repo, 'add', 'keep.py');
    await git(f.repo, 'commit', '-qm', 'will fail');
    const failed = run(f, { FAKE_FAIL: '1' });
    assert.equal(failed.code, 1);
    assert.equal(failed.value.status, 'failed');
    assert.equal(failed.value.head, incremental.value.head);
    assert.equal(failed.value.graphPath, secondGraph);
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    assert.equal(JSON.parse(await readFile(secondGraph, 'utf8')).files.includes('keep.py'), true);
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

test('seeds a compatible feature lane from a validated shared baseline graph', async () => {
  const f = await fixture();
  try {
    const baseline = run(f);
    assert.equal(baseline.code, 0);
    const baselineGraph = baseline.value.graphPath as string;
    await writeFile(path.join(f.repo, 'keep.py'), 'def keep(): return 2\n');
    await git(f.repo, 'mv', 'remove.py', 'renamed.py');
    await writeFile(path.join(f.repo, 'added.py'), 'def added(): return 3\n');
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-qm', 'feature');
    const lane = path.join(f.temp, 'owner', 'feature-cache');
    f.log = path.join(f.temp, 'seed-log.jsonl');
    await writeFile(f.log, '');
    const seeded = run({ ...f, cache: lane }, {}, f.cache);
    assert.equal(seeded.code, 0);
    assert.equal(seeded.value.mode, 'incremental');
    assert.equal(seeded.value.changedFiles, 3);
    assert.equal(seeded.value.deletedFiles, 1);
    assert.notEqual(seeded.value.graphPath, baselineGraph);
    const graph = JSON.parse(await readFile(seeded.value.graphPath as string, 'utf8')) as { files: string[] };
    assert.deepEqual(graph.files, ['added.py', 'caller.py', 'keep.py', 'renamed.py', 'stable.py']);
    const runs = (await readFile(f.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(runs[0], { changed: ['added.py', 'caller.py', 'keep.py', 'renamed.py'], deleted: ['remove.py'] });
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

for (const prefix of ['', 'src/']) test(`reextracts consumers when an added file resolves an external reference under ${prefix || 'root'}`, async () => {
  const f = await fixture();
  try {
    for (const name of ['caller.py', 'keep.py', 'stable.py', 'remove.py']) {
      await rm(path.join(f.repo, name));
    }
    await mkdir(path.join(f.repo, prefix), { recursive: true });
    await writeFile(path.join(f.repo, prefix + 'caller.ts'), 'import { foo } from "./api"; export function call() { return foo(); }\n');
    await writeFile(path.join(f.repo, prefix + 'stable.ts'), 'export function stable() { return 3; }\n');
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-qm', 'reference external module');
    const baseline = run(f);
    assert.equal(baseline.code, 0);
    f.log = path.join(f.temp, 'addition-log.jsonl');
    await writeFile(f.log, '');
    await writeFile(path.join(f.repo, prefix + 'api.ts'), 'export function future_api() { return 9; }\n');
    await git(f.repo, 'add', prefix + 'api.ts');
    await git(f.repo, 'commit', '-qm', 'add provider');
    const incremental = run(f);
    assert.equal(incremental.code, 0);
    assert.equal(incremental.value.mode, 'incremental');
    assert.equal(incremental.value.changedFiles, 1);
    assert.equal(incremental.value.affectedFiles, 1);
    const graph = JSON.parse(await readFile(incremental.value.graphPath as string, 'utf8')) as {
      links: Array<{ source: string; target: string; relation: string; source_file?: string }>;
    };
    assert.deepEqual(graph.links.filter((edge) => edge.source_file === prefix + 'caller.ts')
      .map(({ source, target, relation }) => [source, target, relation]).sort(), [
      ['caller', 'api', 'imports_from'], ['caller', 'api_future_api', 'imports'],
      ['caller', 'caller_call', 'contains'], ['caller_call', 'api_future_api', 'calls'],
    ].map(parts => [prefix.replaceAll('/', '_') + parts[0], prefix.replaceAll('/', '_') + parts[1], parts[2]]));
    const runs = (await readFile(f.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(runs, [
      { changed: [prefix + 'api.ts'], deleted: [] },
      { changed: [prefix + 'caller.ts'], deleted: [] },
    ]);
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

test('reextracts TS and JS consumers when resolver configuration changes', async () => {
  const f = await fixture();
  try {
    for (const name of ['caller.py', 'keep.py', 'stable.py', 'remove.py']) {
      await rm(path.join(f.repo, name));
    }
    await writeFile(path.join(f.repo, 'a.ts'), 'export function foo() { return 1; }\n');
    await writeFile(path.join(f.repo, 'b.ts'), 'export function foo() { return 2; }\n');
    await writeFile(path.join(f.repo, 'caller.ts'), 'import { foo } from "@/api"; export function call() { return foo(); }\n');
    await writeFile(path.join(f.repo, 'stable.ts'), 'export function stable() { return 3; }\n');
    await writeFile(path.join(f.repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@/api': ['a.ts'] },
    } }));
    await git(f.repo, 'add', '-A');
    await git(f.repo, 'commit', '-qm', 'add ts graph fixture');
    const baseline = run(f);
    assert.equal(baseline.code, 0);

    await writeFile(path.join(f.repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      baseUrl: '.', paths: { '@/api': ['b.ts'] },
    } }));
    await git(f.repo, 'add', 'tsconfig.json');
    await git(f.repo, 'commit', '-qm', 'switch path alias');
    const warm = run(f);
    assert.equal(warm.code, 0);
    assert.equal(warm.value.mode, 'incremental');
    assert.equal(warm.value.changedFiles, 1);
    assert.equal(warm.value.affectedFiles, 4);
    const graph = JSON.parse(await readFile(warm.value.graphPath as string, 'utf8')) as {
      links: Array<{ source: string; target: string; relation: string; source_file?: string }>;
    };
    assert.deepEqual(graph.links.filter((edge) => edge.source_file === 'caller.ts')
      .map(({ source, target, relation }) => [source, target, relation]).sort(), [
      ['caller', 'b', 'imports_from'], ['caller', 'b_foo', 'imports'],
      ['caller', 'caller_call', 'contains'], ['caller_call', 'b_foo', 'calls'],
    ]);
    const runs = (await readFile(f.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(runs[1].changed, ['a.ts', 'b.ts', 'caller.ts', 'stable.ts', 'tsconfig.json']);
    const fresh = run({ ...f, cache: path.join(f.temp, 'fresh') });
    const freshGraph = JSON.parse(await readFile(fresh.value.graphPath as string, 'utf8')) as typeof graph;
    assert.deepEqual(graph.links.filter((edge) => edge.source_file === 'caller.ts')
      .map(({ source, target, relation }) => [source, target, relation]).sort(),
      freshGraph.links.filter((edge) => edge.source_file === 'caller.ts')
        .map(({ source, target, relation }) => [source, target, relation]).sort());
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

test('fences concurrent writers with a busy result', async () => {
  const f = await fixture();
  try {
    const first = spawn('python3', [builder, '--repo', f.repo, '--cache-dir', f.cache,
      '--ref', 'HEAD', '--graphify', f.graphify, '--timeout-seconds', '20'], {
      env: { ...process.env, FAKE_LOG: f.log, FAKE_DELAY: '1.5' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      first.once('error', reject);
      first.stdout?.once('data', () => { clearTimeout(timer); resolve(); });
    });
    const second = run(f);
    assert.equal(second.code, 2, JSON.stringify(second.value));
    assert.equal(second.value.status, 'busy');
    await new Promise<void>((resolve, reject) => {
      first.once('error', reject);
      first.once('close', (code) => code === 0 ? resolve() : reject(new Error(`builder exited ${code}`)));
    });
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

test('kills a timed out extractor and leaves no published generation', async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    const result = run(f, { FAKE_DELAY: '2' }, undefined, '0.1');
    assert.equal(result.code, 1);
    assert.equal(result.value.status, 'failed');
    assert.match(result.value.reason, /timed out/);
    assert.equal(Date.now() - started < 1500, true);
    await assert.rejects(stat(path.join(f.cache, 'current')));
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});

test('terminates the extractor process group when the builder receives SIGTERM', async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.temp, 'child-survived');
    const pidFile = path.join(f.temp, 'child.pid');
    const builderProcess = spawn('python3', [builder, '--repo', f.repo, '--cache-dir', f.cache,
      '--ref', 'HEAD', '--graphify', f.graphify, '--timeout-seconds', '20'], {
      env: { ...process.env, FAKE_LOG: f.log, FAKE_DELAY: '10',
        FAKE_CHILD_MARKER: marker, FAKE_CHILD_PID_FILE: pidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    builderProcess.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    const deadline = Date.now() + 4000;
    let childPid: string | undefined;
    while (Date.now() < deadline && !childPid) {
      try { childPid = await readFile(pidFile, 'utf8'); }
      catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    assert.ok(childPid, 'extractor child did not start');
    builderProcess.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve, reject) => {
      builderProcess.once('error', reject);
      builderProcess.once('close', (exitCode) => resolve(exitCode));
    });
    assert.equal(code, 1, output);
    const receipt = JSON.parse(output) as Record<string, any>;
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.reason, /SIGTERM/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await assert.rejects(stat(marker));
    await assert.rejects(stat(path.join(f.cache, 'current')));
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
});
