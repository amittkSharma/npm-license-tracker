import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findScanGaps, IncompleteScanError } from '../src/completeness';
import { completeScan } from '../src/completion';
import { run } from '../src/index';
import { findLicenses, getDependencies } from '../src/npm-license-tracker';
import { detectPackageManager } from '../src/package-manager';
import { mapLimit } from '../src/pool';
import { type FakePackage, makeFixture, makePnpmProject } from './helpers';

const reportOf = async (root: string, options: object = {}) => {
  const { outputFolder } = await run({ path: root, ...options });
  const json = JSON.parse(readFileSync(join(outputFolder, 'npm_licenses.json'), 'utf8')).license;
  return {
    outputFolder,
    json,
    packages: json.packages as Record<string, { dependencyType: string; licenses: string }>,
  };
};
const keys = (p: object) => Object.keys(p).sort();

// a (prod) -> b -> c -> d ;  a -> shared ;  dev-tool (dev) -> shared, dev-only ;  @scope/s (prod, no deps)
const TREE: { prod: string[]; dev: string[]; packages: FakePackage[] } = {
  prod: ['a', '@scope/s'],
  dev: ['dev-tool'],
  packages: [
    { name: 'a', deps: ['b', 'shared'] },
    { name: 'b', deps: ['c'] },
    { name: 'c', deps: ['d'], license: 'ISC' },
    { name: 'd', license: 'BSD-3-Clause' },
    { name: 'shared' },
    { name: '@scope/s', license: '(MIT OR Apache-2.0)' },
    { name: 'dev-tool', deps: ['shared', 'dev-only'] },
    { name: 'dev-only', license: 'Apache-2.0' },
  ],
};

test('pnpm default layout: the whole dependency tree is scanned, not just the linked packages', async () => {
  const { packages, json } = await reportOf(makePnpmProject(TREE));
  assert.deepEqual(keys(packages), [
    '@scope-s:1.0.0',
    'a:1.0.0',
    'b:1.0.0',
    'c:1.0.0',
    'd:1.0.0',
    'dev-only:1.0.0',
    'dev-tool:1.0.0',
    'shared:1.0.0',
  ]);
  assert.equal(packages['c:1.0.0'].licenses, 'ISC');
  assert.equal(packages['@scope-s:1.0.0'].licenses, '(MIT OR Apache-2.0)');
  assert.deepEqual(json.packageManager, {
    name: 'pnpm',
    version: '9.15.9',
    source: 'node_modules/.modules.yaml',
    lockfile: 'pnpm-lock.yaml',
    lockfileVersion: '9.0',
    layout: 'pnpm-store',
  });
});

test('pnpm: direct means declared by the project, however deep in the store it lives', async () => {
  const { packages } = await reportOf(makePnpmProject(TREE));
  const direct = Object.entries(packages)
    .filter(([, p]) => p.dependencyType === 'direct')
    .map(([k]) => k)
    .sort();
  assert.deepEqual(direct, ['@scope-s:1.0.0', 'a:1.0.0', 'dev-tool:1.0.0']);
});

test('pnpm: every license file is copied and is the right one', async () => {
  const { outputFolder, packages } = await reportOf(makePnpmProject(TREE));
  assert.equal(readdirSync(join(outputFolder, 'licenses')).length, Object.keys(packages).length);
  assert.equal(
    readFileSync(join(outputFolder, 'licenses', 'd@1.0.0'), 'utf8'),
    'License text of d@1.0.0\n',
  );
  assert.equal(
    readFileSync(join(outputFolder, 'licenses', '@scope-s@1.0.0'), 'utf8'),
    'License text of @scope/s@1.0.0\n',
  );
});

test('pnpm --production leaves out dev-only packages but keeps what production code also uses', async () => {
  const { packages } = await reportOf(makePnpmProject(TREE), { production: true });
  assert.deepEqual(keys(packages), [
    '@scope-s:1.0.0',
    'a:1.0.0',
    'b:1.0.0',
    'c:1.0.0',
    'd:1.0.0',
    'shared:1.0.0',
  ]);
});

test('pnpm: excluded packages are neither reported nor mistaken for missing ones', async () => {
  const priv = makePnpmProject({
    ...TREE,
    packages: TREE.packages.map((p) => (p.name === 'c' ? { ...p, private: true } : p)),
  });
  const a = await reportOf(priv, { excludePrivatePackages: true });
  assert.ok(!('c:1.0.0' in a.packages));
  assert.ok('b:1.0.0' in a.packages && 'd:1.0.0' in a.packages); // d is reachable through c and still scanned
  const b = await reportOf(makePnpmProject(TREE), { excludePackages: ['shared', 'dev-only@1'] });
  assert.ok(!('shared:1.0.0' in b.packages) && !('dev-only:1.0.0' in b.packages));
});

test('pnpm: a dependency that is linked but missing from the store is reported, not skipped', async () => {
  const root = makePnpmProject({
    prod: ['a'],
    packages: [{ name: 'a', deps: ['b'] }, { name: 'b' }],
  });
  rmSync(join(root, 'node_modules/.pnpm/b@1.0.0'), { recursive: true });
  await assert.rejects(run({ path: root }), (err) => err instanceof IncompleteScanError);
});

test('completeScan: a flat install needs no extra scans', async () => {
  const root = makeFixture();
  const scanned = await findLicenses(root);
  let calls = 0;
  const result = await completeScan(
    root,
    getDependencies({ foo: '^1.0.0' }, {}),
    scanned,
    {},
    async () => {
      calls++;
      return {};
    },
  );
  assert.equal(calls, 0);
  assert.deepEqual(keys(result), keys(scanned));
});

test('completeScan: each real folder is scanned once, however many packages link to it, and a silent folder ends the loop', async () => {
  const root = makePnpmProject({
    prod: ['a', 'b'],
    packages: [
      { name: 'a', deps: ['shared'] },
      { name: 'b', deps: ['shared'] },
      { name: 'shared' },
    ],
  });
  const declared = getDependencies({ a: '1.0.0', b: '1.0.0' }, {});
  const first = await findLicenses(root);
  const dirs: string[] = [];
  const result = await completeScan(root, declared, first, {}, async (dir) => {
    dirs.push(dir);
    return {}; // the scanner finds nothing here
  });
  assert.equal(dirs.length, 1, 'shared is linked from two packages but scanned once');
  assert.match(dirs[0], /shared@1\.0\.0/, 'the canonical store folder, not a symlink path');
  assert.equal(keys(result).includes('shared:1.0.0'), false);
  // the remaining gap is still reported, and the loop terminated
  assert.deepEqual(
    findScanGaps(root, declared, result, {}).map((g) => g.what),
    ['shared@1.0.0'],
  );
});

test('mapLimit keeps the order and never exceeds the limit', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 4, 3, 2, 1, 0], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 40, 30, 20, 10, 0]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 3, async (x) => x), []);
});

test('a deep chain needs several rounds and still completes', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const packages: FakePackage[] = names.map((name, i) => ({
    name,
    deps: i < 11 ? [names[i + 1]] : [],
  }));
  const { packages: report } = await reportOf(makePnpmProject({ prod: ['p0'], packages }));
  assert.equal(Object.keys(report).length, 12);
});

test('the pnpm project is left untouched', async () => {
  const root = makePnpmProject({ prod: ['a'], packages: [{ name: 'a' }] });
  const before = readdirSync(join(root, 'node_modules')).sort();
  await run({ path: root });
  assert.deepEqual(readdirSync(join(root, 'node_modules')).sort(), before);
  assert.equal(existsSync(join(root, 'node_modules', '.pnpm')), true);
});

test("pnpm: an optional dependency that IS installed (this platform's binary) is reported; one that is not, is not an error", async () => {
  const root = makePnpmProject({
    prod: ['tool'],
    packages: [
      { name: 'tool', optionalDeps: ['native-darwin', 'native-win32'] },
      { name: 'native-darwin', license: 'ISC' }, // installed: this platform
      // native-win32 is nowhere in the project: pnpm did not install it here
    ],
  });
  const { packages } = await reportOf(root);
  assert.deepEqual(keys(packages), ['native-darwin:1.0.0', 'tool:1.0.0']);
  assert.equal(packages['native-darwin:1.0.0'].licenses, 'ISC');
});

test('mapLimit: after a failure nothing new starts, and the error is thrown only once running tasks have finished', async () => {
  const log: string[] = [];
  const started: number[] = [];
  await assert.rejects(
    mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 40)); // still running when task 0 has already failed
      log.push(`finished ${n}`);
      return n;
    }),
    /boom/,
  );
  // callers clean up shared state (a temporary folder) as soon as this rejects, so task 1 must be done by then
  assert.deepEqual(log, ['finished 1']);
  assert.deepEqual(started, [0, 1]); // 2..5 never started
});

test('pnpm: the layout is recognised when every top-level dependency is scoped', async () => {
  const root = makePnpmProject({
    prod: ['@scope/a', '@scope/b'],
    packages: [{ name: '@scope/a', deps: ['@scope/b'] }, { name: '@scope/b' }],
  });
  assert.equal(detectPackageManager(root).layout, 'pnpm-store');
  const { packages } = await reportOf(root);
  assert.deepEqual(keys(packages), ['@scope-a:1.0.0', '@scope-b:1.0.0']);
});
