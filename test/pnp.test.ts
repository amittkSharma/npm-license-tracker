import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { IncompleteScanError } from '../src/completeness';
import { run } from '../src/index';
import { listPnpPackages, readPnpState } from '../src/pnp';
import { readVirtualFile, splitZipPath } from '../src/zip-fs';
import { type FakePackage, makePnpProject, makeTree } from './helpers';

const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ['--import', 'tsx', 'bin/npm-tracker.ts', ...args]);

const reportOf = async (root: string, options: object = {}) => {
  const { outputFolder } = await run({ path: root, ...options });
  const json = JSON.parse(readFileSync(join(outputFolder, 'npm_licenses.json'), 'utf8')).license;
  return {
    outputFolder,
    json,
    packages: json.packages as Record<
      string,
      { dependencyType: string; licenses: string; 'license file': string }
    >,
  };
};
const keys = (p: object) => Object.keys(p).sort();

// a (prod) -> b -> c ; a -> shared ; @scope/s (prod) ; dev-tool (dev) -> shared, dev-only (unplugged, a real folder)
const TREE: { prod: string[]; dev: string[]; packages: FakePackage[] } = {
  prod: ['a', '@scope/s'],
  dev: ['dev-tool'],
  packages: [
    { name: 'a', deps: ['b', 'shared'] },
    { name: 'b', deps: ['c'] },
    { name: 'c', license: 'ISC' },
    { name: 'shared' },
    { name: '@scope/s', license: '(MIT OR Apache-2.0)' },
    { name: 'dev-tool', deps: ['shared', 'dev-only'] },
    { name: 'dev-only', license: 'Apache-2.0', unplugged: true },
  ],
};

test('the parser reads a REAL Yarn 4.5.3 .pnp.cjs', () => {
  const fixture = join(__dirname, 'fixtures');
  const root = makeTree({
    'package.json': { name: 'tiny', version: '1.0.0', dependencies: { ms: '2.1.3' } },
  });
  writeFileSync(join(root, '.pnp.cjs'), readFileSync(join(fixture, 'yarn-4.5.3.pnp.cjs')));
  const { packages, rootDependencies, orphans } = listPnpPackages(readPnpState(root), root);
  assert.deepEqual([...packages.keys()], ['ms@npm:2.1.3']);
  assert.equal(rootDependencies.get('ms'), 'ms@npm:2.1.3');
  assert.deepEqual(orphans, []);
  const ms = packages.get('ms@npm:2.1.3');
  assert.ok(ms?.dir.endsWith('.zip/node_modules/ms'), ms?.dir);
});

test('the parser undoes JavaScript string escapes: quotes, backslashes and line continuations', () => {
  const root = makePnpProject({ prod: ["it's"], packages: [{ name: "it's" }] }); // an apostrophe in a package name
  const { packages } = listPnpPackages(readPnpState(root), root);
  assert.deepEqual([...packages.keys()], ["it's@npm:1.0.0"]);
});

test('registry entries: virtual instances fold into their SOFT base; workspaces are skipped; orphans are found', () => {
  const root = makePnpProject(TREE, {
    virtual: ['b'],
    extraLocal: ['w'],
    orphanVirtual: ['ghost'],
  });
  const { packages, orphans } = listPnpPackages(readPnpState(root), root);
  assert.deepEqual([...packages.keys()].sort(), [
    '@scope/s@npm:1.0.0',
    'a@npm:1.0.0',
    'b@npm:1.0.0',
    'c@npm:1.0.0',
    'dev-only@npm:1.0.0',
    'dev-tool@npm:1.0.0',
    'shared@npm:1.0.0',
  ]);
  assert.deepEqual(orphans, ['ghost@npm:9.9.9']);
  // the virtual instance's dependencies were merged into the real package
  assert.ok(packages.get('b@npm:1.0.0')?.dependencies.has('c@npm:1.0.0'));
  assert.ok(
    packages.get('b@npm:1.0.0')?.dir.includes('.zip/'),
    'the real location, never the __virtual__ one',
  );
});

test("Plug'n'Play: every package is scanned, from zip archives and from unplugged folders", async () => {
  const { packages, json } = await reportOf(makePnpProject(TREE));
  assert.deepEqual(keys(packages), [
    '@scope-s:1.0.0',
    'a:1.0.0',
    'b:1.0.0',
    'c:1.0.0',
    'dev-only:1.0.0',
    'dev-tool:1.0.0',
    'shared:1.0.0',
  ]);
  assert.equal(packages['c:1.0.0'].licenses, 'ISC');
  assert.equal(packages['dev-only:1.0.0'].licenses, 'Apache-2.0'); // unplugged: a real folder
  assert.deepEqual(
    [
      json.packageManager.name,
      json.packageManager.family,
      json.packageManager.versionHint,
      json.packageManager.layout,
    ],
    ['yarn', 'berry', '4.x', 'pnp'],
  );
});

test("Plug'n'Play: direct means declared by the project (also through virtual instances)", async () => {
  const { packages } = await reportOf(makePnpProject(TREE, { virtual: ['a', 'dev-tool'] }));
  const direct = Object.entries(packages)
    .filter(([, p]) => p.dependencyType === 'direct')
    .map(([k]) => k)
    .sort();
  assert.deepEqual(direct, ['@scope-s:1.0.0', 'a:1.0.0', 'dev-tool:1.0.0']);
});

test("Plug'n'Play: license files show Yarn's own archive path and are copied out of the zip", async () => {
  const { outputFolder, packages } = await reportOf(makePnpProject(TREE));
  assert.match(
    packages['c:1.0.0']['license file'],
    /c-npm-1\.0\.0-[0-9a-f]+-10c0\.zip\/node_modules\/c\/LICENSE$/,
  );
  // the real package license, not the decoy deeper in the archive (lib/LICENSE)
  assert.equal(
    readFileSync(join(outputFolder, 'licenses', 'c@1.0.0'), 'utf8'),
    'License text of c@1.0.0\n',
  );
  assert.equal(
    readFileSync(join(outputFolder, 'licenses', 'dev-only@1.0.0'), 'utf8'),
    'License text of dev-only@1.0.0\n',
  );
  assert.equal(readdirSync(join(outputFolder, 'licenses')).length, 7);
});

test("Plug'n'Play --production follows the dependency graph from the project's dependencies", async () => {
  const { packages } = await reportOf(makePnpProject(TREE), { production: true });
  assert.deepEqual(keys(packages), [
    '@scope-s:1.0.0',
    'a:1.0.0',
    'b:1.0.0',
    'c:1.0.0',
    'shared:1.0.0',
  ]);
});

test("Plug'n'Play: exclusions apply, and an excluded package's own dependencies are still reported", async () => {
  const priv = makePnpProject({
    ...TREE,
    packages: TREE.packages.map((p) => (p.name === 'b' ? { ...p, private: true } : p)),
  });
  const a = await reportOf(priv, { excludePrivatePackages: true });
  assert.ok(!('b:1.0.0' in a.packages) && 'c:1.0.0' in a.packages);
  const b = await reportOf(makePnpProject(TREE), { excludePackages: ['shared', 'dev-only@1'] });
  assert.ok(!('shared:1.0.0' in b.packages) && !('dev-only:1.0.0' in b.packages));
});

test("Plug'n'Play: a missing archive and an unreadable virtual instance are reported, never skipped", async () => {
  await assert.rejects(run({ path: makePnpProject(TREE, { missingZip: ['c'] }) }), (err) => {
    assert.ok(err instanceof IncompleteScanError);
    assert.deepEqual(
      err.gaps.map((g) => [g.kind, g.what]),
      [['not-installed', 'c@npm:1.0.0']],
    );
    return true;
  });
  await assert.rejects(run({ path: makePnpProject(TREE, { orphanVirtual: ['ghost'] }) }), (err) => {
    assert.ok(err instanceof IncompleteScanError);
    assert.deepEqual(
      err.gaps.map((g) => [g.kind, g.what]),
      [['not-scanned', 'ghost@npm:9.9.9']],
    );
    return true;
  });
  // ... unless the user accepts an incomplete report
  const { packages } = await reportOf(makePnpProject(TREE, { missingZip: ['c'] }), {
    allowIncomplete: true,
  });
  assert.ok(!('c:1.0.0' in packages) && 'b:1.0.0' in packages);
});

test('pnpDataPath: the state can live in .pnp.data.json', async () => {
  const { packages } = await reportOf(makePnpProject(TREE, { dataFile: true }));
  assert.equal(Object.keys(packages).length, 7);
});

test('a corrupt .pnp.cjs fails with a clear message', async () => {
  const root = makePnpProject(TREE);
  writeFileSync(join(root, '.pnp.cjs'), 'this is not a Yarn file');
  await assert.rejects(cli('--path', root), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Cannot read Yarn Plug'n'Play data/);
    return true;
  });
});

test('.pnp.cjs is parsed, never executed (it is code from the project being scanned)', async () => {
  const root = makePnpProject(TREE);
  const marker = join(mkdtempSync(join(tmpdir(), 'nlt-marker-')), 'EXECUTED');
  const original = readFileSync(join(root, '.pnp.cjs'), 'utf8');
  writeFileSync(
    join(root, '.pnp.cjs'),
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n${original}`,
  );
  await run({ path: root });
  assert.equal(existsSync(marker), false);
});

test('no temporary files are left behind, and the project is not modified', async () => {
  const root = makePnpProject(TREE);
  const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('nlt-pnp-')).length;
  const before = leftovers();
  const files = readdirSync(root).sort();
  await run({ path: root });
  assert.equal(leftovers(), before);
  assert.deepEqual(
    readdirSync(root)
      .filter((n) => n !== 'npm_licenses')
      .sort(),
    files,
  );
});

test('the result does not depend on scan order (8 packages are read concurrently)', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `pkg-${i}`);
  const packages: FakePackage[] = names.map((name, i) => ({
    name,
    deps: i < 39 ? [names[i + 1]] : [],
  }));
  const root = makePnpProject({ prod: ['pkg-0'], packages });
  const a = await reportOf(root);
  const b = await reportOf(root);
  assert.equal(Object.keys(a.packages).length, 40);
  assert.deepEqual(keys(a.packages), keys(b.packages));
});

test('zip paths: split, read, and tolerate both separators', () => {
  assert.deepEqual(splitZipPath('/c/x-npm-1.zip/node_modules/x/LICENSE'), {
    zip: '/c/x-npm-1.zip',
    inner: 'node_modules/x/LICENSE',
  });
  assert.deepEqual(splitZipPath('C:\\cache\\x.zip\\node_modules\\x\\LICENSE'), {
    zip: 'C:\\cache\\x.zip',
    inner: 'node_modules/x/LICENSE',
  });
  assert.equal(splitZipPath('/plain/node_modules/x/LICENSE'), undefined);
  const root = makePnpProject({ prod: ['a'], packages: [{ name: 'a' }] });
  const zip = join(root, '.yarn/cache', readdirSync(join(root, '.yarn/cache'))[0]);
  assert.equal(
    Buffer.from(readVirtualFile(`${zip}/node_modules/a/LICENSE`) as Uint8Array).toString(),
    'License text of a@1.0.0\n',
  );
  assert.equal(readVirtualFile(`${zip}/node_modules/a/missing`), undefined);
  assert.equal(readVirtualFile('/no/such.zip/node_modules/a/LICENSE'), undefined);
});

test('a virtual instance brings its peer dependencies with it: they are reachable and kept under --production', async () => {
  const withPeer = {
    ...TREE,
    packages: [...TREE.packages, { name: 'peer-only', license: 'MIT-0' }],
  };
  // peer-only is a dependency of no package, except through b's virtual (peer-resolved) instance
  const root = makePnpProject(withPeer, { virtual: ['b'], virtualOnlyDeps: { b: ['peer-only'] } });
  const { packages } = await reportOf(root, { production: true });
  assert.ok('peer-only:1.0.0' in packages, 'reachable through the virtual instance of b');
  const without = await reportOf(makePnpProject(withPeer, { virtual: ['b'] }), {
    production: true,
  });
  assert.ok(
    !('peer-only:1.0.0' in without.packages),
    'and not reported when nothing depends on it',
  );
});

test("Plug'n'Play: platform binaries Yarn lists but never unpacked are skipped only when some package declares them optional", async () => {
  const optional = {
    prod: ['tool'],
    packages: [
      { name: 'tool', optionalDeps: ['native-linux', 'native-win32'] },
      { name: 'native-linux', absent: true }, // another OS: listed, not unpacked
      { name: 'native-win32', absent: true },
    ],
  };
  const { packages } = await reportOf(makePnpProject(optional));
  assert.deepEqual(keys(packages), ['tool:1.0.0']); // no error, nothing invented
  // the same files missing from a REQUIRED dependency is an unfinished install, and says so
  const required = {
    prod: ['tool'],
    packages: [
      { name: 'tool', deps: ['core'] },
      { name: 'core', absent: true },
    ],
  };
  await assert.rejects(run({ path: makePnpProject(required) }), (err) => {
    assert.ok(err instanceof IncompleteScanError);
    assert.deepEqual(
      err.gaps.map((g) => [g.kind, g.what]),
      [['not-installed', 'core@npm:1.0.0']],
    );
    return true;
  });
});

test("Plug'n'Play monorepo: --production follows each workspace member's dependencies, not its devDependencies", async () => {
  const monorepo = {
    prod: [] as string[], // nothing at the root: everything is needed by workspace members
    packages: [
      { name: 'express', deps: ['body'] },
      { name: 'body' },
      { name: 'jest', deps: ['jest-core'] },
      { name: 'jest-core' },
      { name: 'lodash' },
    ],
    workspaces: [
      { name: 'api', deps: ['express'], devDeps: ['jest'] },
      { name: 'web', deps: ['lodash'] },
    ],
  };
  const root = makePnpProject(monorepo);
  const all = await reportOf(root);
  assert.deepEqual(keys(all.packages), [
    'body:1.0.0',
    'express:1.0.0',
    'jest-core:1.0.0',
    'jest:1.0.0',
    'lodash:1.0.0',
  ]);
  const prod = await reportOf(root, { production: true });
  assert.deepEqual(keys(prod.packages), ['body:1.0.0', 'express:1.0.0', 'lodash:1.0.0']); // jest is a devDependency of a member
});
