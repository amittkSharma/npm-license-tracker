import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { findScanGaps, IncompleteScanError } from '../src/completeness';
import { IncompleteScanError as ExportedError, run } from '../src/index';
import { findLicenses, getDependencies } from '../src/npm-license-tracker';
import type { LicenseMap } from '../src/types';
import { makeFixture, makePnpmLikeProject, makeTree } from './helpers';

const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ['--import', 'tsx', 'bin/npm-tracker.ts', ...args]);

const pkg = (name: string, extra: object = {}) => ({
  name,
  version: '1.0.0',
  license: 'MIT',
  ...extra,
});
const deps = (o: Record<string, string>) => getDependencies(o, {});
// what the scanner returns for packages linked in <root>/node_modules (name@version -> info with its path)
const scannedAs = (root: string, ...keys: string[]): LicenseMap =>
  Object.fromEntries(
    keys.map((k) => {
      const [name, version] = k.split('@');
      return [k, { name, version, path: join(root, 'node_modules', name) }];
    }),
  );

test('a healthy install has no gaps (the real scanner against a real tree)', async () => {
  const root = makeFixture();
  const scanned = await findLicenses(root);
  const declared = getDependencies({ foo: '^1.0.0', '@sc/bar': '2.0.0' }, { baz: '3.0.0' });
  assert.deepEqual(findScanGaps(root, declared, scanned), []);
});

test('nothing installed: every declared dependency is reported as not installed', () => {
  const root = makeTree({
    'package.json': { name: 'fresh', dependencies: { lodash: '1.0.0', ms: '1.0.0' } },
  });
  const gaps = findScanGaps(root, deps({ lodash: '1.0.0', ms: '1.0.0' }), {});
  assert.deepEqual(
    gaps.map((g) => [g.kind, g.what, g.requiredBy]),
    [
      ['not-installed', 'lodash', 'package.json'],
      ['not-installed', 'ms', 'package.json'],
    ],
  );
});

test('a project that declares nothing and has nothing installed is complete', () => {
  assert.deepEqual(findScanGaps(makeTree({ 'package.json': pkg('empty') }), [], {}), []);
});

test('devDependencies are not required when scanning production only', () => {
  const root = makeTree({ 'package.json': pkg('p') });
  const declared = getDependencies({}, { jest: '1.0.0' });
  assert.equal(findScanGaps(root, declared, {}).length, 1);
  assert.deepEqual(findScanGaps(root, declared, {}, { production: true }), []);
});

test('a dependency of an installed package that is nowhere on disk is a gap', () => {
  const root = makeTree({
    'package.json': pkg('app', { dependencies: { a: '1.0.0' } }),
    'node_modules/a/package.json': pkg('a', { dependencies: { z: '1.0.0' } }),
  });
  const gaps = findScanGaps(root, deps({ a: '1.0.0' }), scannedAs(root, 'a@1.0.0'), {});
  assert.deepEqual(
    gaps.map((g) => [g.kind, g.what, g.requiredBy]),
    [['not-installed', 'z', 'a@1.0.0']],
  );
});

test('optional dependencies may be absent (platform packages): not a gap', () => {
  const root = makeTree({
    'package.json': pkg('app', { dependencies: { a: '1.0.0' } }),
    'node_modules/a/package.json': pkg('a', {
      dependencies: { fsevents: '1.0.0' },
      optionalDependencies: { fsevents: '1.0.0' },
    }),
  });
  assert.deepEqual(findScanGaps(root, deps({ a: '1.0.0' }), scannedAs(root, 'a@1.0.0')), []);
});

test('one version installed in several places is one scan entry, not a gap (real-tree regression)', () => {
  // s@1.0.0 lives at the top AND nested under y; the scanner reports it once, under one path
  const root = makeTree({
    'package.json': pkg('app', { dependencies: { x: '1.0.0', y: '1.0.0' } }),
    'node_modules/x/package.json': pkg('x', { dependencies: { s: '1.0.0' } }),
    'node_modules/y/package.json': pkg('y', { dependencies: { s: '1.0.0' } }),
    'node_modules/y/node_modules/s/package.json': pkg('s'),
    'node_modules/s/package.json': pkg('s'),
  });
  const gaps = findScanGaps(
    root,
    deps({ x: '1.0.0', y: '1.0.0' }),
    scannedAs(root, 'x@1.0.0', 'y@1.0.0', 's@1.0.0'),
  );
  assert.deepEqual(gaps, []);
});

test('pnpm-style layout: installed packages the scan result lacks are reported', () => {
  const root = makePnpmLikeProject();
  // only what the scanner can see: the package linked in node_modules (a), not its siblings (b)
  const gaps = findScanGaps(root, deps({ a: '1.0.0' }), scannedAs(root, 'a@1.0.0'));
  assert.deepEqual(
    gaps.map((g) => [g.kind, g.what, g.requiredBy]),
    [['not-scanned', 'b@1.0.0', 'a@1.0.0']],
  );
});

test('packages excluded on purpose are not gaps; the same package is a gap without the exclusion', () => {
  const root = makeTree({
    'package.json': pkg('app', { dependencies: { a: '1.0.0' } }),
    'node_modules/a/package.json': pkg('a', { dependencies: { internal: '1.0.0', big: '2.0.0' } }),
    'node_modules/internal/package.json': pkg('internal', { private: true }),
    'node_modules/big/package.json': { name: 'big', version: '2.3.4', license: 'MIT' },
  });
  const scanned = scannedAs(root, 'a@1.0.0');
  const declared = deps({ a: '1.0.0' });
  assert.equal(findScanGaps(root, declared, scanned, {}).length, 2);
  assert.deepEqual(
    findScanGaps(root, declared, scanned, {
      excludePrivatePackages: true,
      excludePackages: ['big@2'],
    }).map((g) => g.what),
    [],
  );
  // the scanner's own rule: `name`, `name@major`, `name@version`
  assert.deepEqual(
    findScanGaps(root, declared, scanned, { excludePackages: ['internal', 'big'] }),
    [],
  );
  assert.equal(findScanGaps(root, declared, scanned, { excludePackages: ['big@3'] }).length, 2);
});

test('the error lists what is missing, caps the list, and carries the gaps', () => {
  const gaps = Array.from({ length: 13 }, (_, i) => ({
    kind: 'not-installed' as const,
    what: `dep-${i}`,
    requiredBy: 'package.json',
  }));
  const err = new IncompleteScanError(gaps);
  assert.equal(err.name, 'IncompleteScanError');
  assert.equal(err.gaps.length, 13);
  assert.match(err.message, /Not installed:\n {4}- dep-0 \(required by package\.json\)/);
  assert.match(err.message, /\.\.\. and 3 more/);
  assert.doesNotMatch(err.message, /dep-12/);
  assert.match(err.message, /--allowIncomplete/);
  assert.equal(ExportedError, IncompleteScanError); // exported from the package entry point
});

test('CLI: dependencies not installed fails with exit 1 and writes nothing', async () => {
  const root = makeTree({
    'package.json': { name: 'fresh-clone', version: '1.0.0', dependencies: { lodash: '4.17.21' } },
  });
  await assert.rejects(
    cli('--path', root, '--format', 'all'),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /The scan is incomplete/);
      assert.match(err.stderr, /lodash \(required by package\.json\)/);
      return true;
    },
  );
  assert.equal(existsSync(join(root, 'npm_licenses')), false);
});

test('--allowIncomplete writes the report anyway, with a loud warning', async () => {
  const root = makeTree({ 'package.json': pkg('app', { dependencies: { lodash: '1.0.0' } }) });
  const { stdout, stderr } = await cli('--path', root, '--allowIncomplete');
  assert.match(stderr, /Warning: The scan is incomplete/);
  assert.match(stdout, /Output folder:/);
  assert.equal(existsSync(join(root, 'npm_licenses')), true);
});

test('API: run() rejects with an IncompleteScanError; allowIncomplete resolves', async () => {
  const root = makeTree({ 'package.json': pkg('app', { dependencies: { lodash: '1.0.0' } }) });
  await assert.rejects(run({ path: root }), (err) => {
    assert.ok(err instanceof IncompleteScanError);
    assert.deepEqual(
      err.gaps.map((g) => g.what),
      ['lodash'],
    );
    return true;
  });
  const { outputFolder } = await run({ path: root, allowIncomplete: true });
  assert.ok(existsSync(join(outputFolder, 'npm_licenses.json')));
});

test('a monorepo with workspaces is not a false alarm', async () => {
  const root = makeTree(
    {
      'package.json': {
        name: 'mono',
        version: '1.0.0',
        workspaces: ['packages/*'],
        dependencies: { lodash: '1.0.0' },
      },
      'node_modules/lodash/package.json': pkg('lodash'),
      'node_modules/ms/package.json': pkg('ms'),
      'packages/a/package.json': pkg('@mono/a', { dependencies: { ms: '1.0.0' } }),
    },
    { 'node_modules/@mono/a': 'packages/a' },
  );
  await run({ path: root });
});

test("the project's own optional and peer dependencies are direct, and may be absent without an error", async () => {
  const root = makeTree({
    'package.json': pkg('app', {
      dependencies: { a: '1.0.0' },
      optionalDependencies: { fsevents: '1.0.0', 'linux-only': '1.0.0' }, // fsevents installed here, the other is not
      peerDependencies: { react: '18.0.0', 'peer-missing': '1.0.0' }, // react installed, the other is not
    }),
    'node_modules/a/package.json': pkg('a'),
    'node_modules/fsevents/package.json': pkg('fsevents'),
    'node_modules/react/package.json': pkg('react'),
  });
  const { outputFolder } = await run({ path: root });
  const report = JSON.parse(readFileSync(join(outputFolder, 'npm_licenses.json'), 'utf8')).license
    .packages;
  const types = Object.fromEntries(
    Object.entries(report).map(([k, v]) => [k, (v as { dependencyType: string }).dependencyType]),
  );
  assert.deepEqual(types, {
    'a:1.0.0': 'direct',
    'fsevents:1.0.0': 'direct',
    'react:1.0.0': 'direct',
  });
  // a REQUIRED dependency that is missing is still an error
  const broken = makeTree({
    'package.json': pkg('app', {
      dependencies: { gone: '1.0.0' },
      optionalDependencies: { fsevents: '1.0.0' },
    }),
  });
  await assert.rejects(run({ path: broken }), /Not installed:\n\s+- gone/);
});
