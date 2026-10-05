import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as exceptions from '../src/exceptions';
import { FORMATS, selectFormats } from '../src/formats';
import {
  createRunFolder,
  getDependencies,
  getExtendedJson,
  normalizeLicenses,
  planLicenseFiles,
  readModulePackageJson,
  toList,
  validateClarificationsFile,
} from '../src/npm-license-tracker';
import { checkLicensePolicy } from '../src/policy';
import {
  licenseFileName,
  licenseLabel,
  reportDate,
  reportTimestamp,
  runFolderName,
  summarize,
} from '../src/report-model';
import type { PackageEntry } from '../src/types';
import { makeFixture, writeJson } from './helpers';

test('exceptions format their messages', () => {
  assert.equal(exceptions.NoProperArguments('x'), 'module stopped working: x');
  assert.equal(exceptions.ErrorInWritingFile('/a'), 'not able to write the file: /a');
  assert.equal(
    exceptions.ErrorInReadingNpmPackages('/a', 'boom'),
    'fail to read npm packages at: /a and error is: boom',
  );
});

test('getDependencies strips ^ from labels and tolerates missing sections', () => {
  const deps = getDependencies({ a: '^1.2.3', b: '2.0.0' }, { c: '^3.0.0' });
  assert.deepEqual(
    deps.map((d) => [d.label, d.type]),
    [
      ['a@1.2.3', 'dependency'],
      ['b@2.0.0', 'dependency'],
      ['c@3.0.0', 'devDependency'],
    ],
  );
  assert.deepEqual(getDependencies(undefined, undefined), []);
});

test('getExtendedJson maps entries, flattens scoped names and tags dependency type', () => {
  const report = getExtendedJson(
    '/p',
    {
      'a@1.0.0': {
        name: 'a',
        version: '1.0.0',
        licenses: 'MIT',
        repository: 'git+https://github.com/acme/a.git',
        email: 'e@x.io',
        licenseFile: '/p/node_modules/a/LICENSE',
      },
      '@s/b@2.0.0': { name: '@s/b', version: '2.0.0', licenses: 'ISC' },
    },
    getDependencies({ a: '^1.0.0' }, {}),
  );
  assert.equal(report.license.path, '/p');
  const a = report.license.packages['a:1.0.0'];
  assert.equal(a.dependencyType, 'direct');
  assert.equal(a['download url'], 'https://github.com/acme/a.git');
  assert.equal(a.publisher, 'acme');
  assert.equal(a['publisher contact information'], 'e@x.io');
  const b = report.license.packages['@s-b:2.0.0'];
  assert.equal(b.dependencyType, 'transitive');
  assert.equal(b['download url'], 'No information found');
  assert.equal(b.publisher, 'No information found');
});

test('getExtendedJson replaces license-checker placeholders with fallbacks', () => {
  const report = getExtendedJson(
    '/p',
    {
      'a@1.0.0': {
        name: 'a',
        version: '1.0.0',
        licenses: 'MIT',
        description: '<<Default Description>>',
        publisher: '<<Default Publisher>>',
        email: '<<Default Email>>',
        repository: 'https://github.com/acme/a',
      },
    },
    [],
  );
  const a = report.license.packages['a:1.0.0'];
  assert.equal(a.publisher, 'acme');
  assert.equal(a['publisher contact information'], 'https://github.com/acme/a');
  assert.equal(a.description, 'No information found');
  assert.ok(!JSON.stringify(report).includes('<<Default'));
});

test('getExtendedJson leaves out the root project', () => {
  const report = getExtendedJson(
    '/p',
    {
      'root@1.0.0': { name: 'root', version: '1.0.0', licenses: 'MIT' },
      'dep@1.0.0': { name: 'dep', version: '1.0.0', licenses: 'MIT' },
    },
    [],
    'root@1.0.0',
  );
  assert.deepEqual(Object.keys(report.license.packages), ['dep:1.0.0']);
});

const pkg = (name: string, version: string, file: string): PackageEntry =>
  ({ 'package name': name, 'package version': version, 'license file': file }) as PackageEntry;

test('planLicenseFiles always names files name@version and reports missing', () => {
  const { files, missing } = planLicenseFiles({
    'a:1.0.0': pkg('a', '1.0.0', '/a/LICENSE'),
    'b:1.0.0': pkg('b', '1.0.0', '/b1/LICENSE'),
    'b:2.0.0': pkg('b', '2.0.0', '/b2/LICENSE'),
    'c:1.0.0': pkg('c', '1.0.0', 'none'),
  });
  assert.deepEqual(files, {
    'a@1.0.0': '/a/LICENSE',
    'b@1.0.0': '/b1/LICENSE',
    'b@2.0.0': '/b2/LICENSE',
  });
  assert.deepEqual(missing, ['c:1.0.0']);
});

test('normalizeLicenses always returns a string', () => {
  assert.equal(normalizeLicenses('MIT'), 'MIT');
  assert.equal(normalizeLicenses(['MIT']), 'MIT');
  assert.equal(normalizeLicenses(['MIT', 'ISC']), 'MIT OR ISC');
  assert.equal(normalizeLicenses(['<<Default Licenses>>']), 'No information found');
  assert.equal(normalizeLicenses([]), 'No information found');
  assert.equal(normalizeLicenses(undefined), 'No information found');
});

test('readModulePackageJson returns the root key and rejects when unreadable', async () => {
  const root = makeFixture();
  const info = await readModulePackageJson(root);
  assert.equal(info.rootKey, 'fx@1.0.0');
  assert.equal(info.declared.length, 3);
  await assert.rejects(readModulePackageJson(`${root}/nope`), /Not able to read the package file/);
});

test('direct is decided by install location, not by the declared version range', () => {
  const root = makeFixture();
  const at = (dir: string) => join(root, 'node_modules', dir);
  const info = (name: string, version: string, dir: string) => ({
    name,
    version,
    licenses: 'MIT',
    path: at(dir),
  });
  const report = getExtendedJson(
    root,
    {
      'foo@1.0.0': info('foo', '1.0.0', 'foo'),
      'foo@2.0.0': info('foo', '2.0.0', 'baz/node_modules/foo'),
      'bar@2.0.0': info('bar', '2.0.0', 'aliased'),
      'baz@3.0.0': info('baz', '3.0.0', 'baz'),
    },
    // ~ range, npm alias (installed under the alias name), tag
    getDependencies({ foo: '~1.0.0', aliased: 'npm:bar@2.0.0' }, { baz: 'latest' }),
  );
  const types = Object.fromEntries(
    Object.entries(report.license.packages).map(([k, v]) => [k, v.dependencyType]),
  );
  assert.deepEqual(types, {
    'foo:1.0.0': 'direct',
    'foo:2.0.0': 'transitive',
    'bar:2.0.0': 'direct',
    'baz:3.0.0': 'direct',
  });
});

test('symlinked installs (pnpm, npm link) still count as direct', () => {
  const root = makeFixture();
  const store = join(root, '.store', 'real-pkg');
  mkdirSync(store, { recursive: true });
  symlinkSync(store, join(root, 'node_modules', 'linked'));
  const report = getExtendedJson(
    root,
    { 'linked@1.0.0': { name: 'linked', version: '1.0.0', licenses: 'MIT', path: store } },
    getDependencies({ linked: '1.0.0' }),
  );
  assert.equal(report.license.packages['linked:1.0.0'].dependencyType, 'direct');
});

const entry = (licenses: string) => ({ licenses }) as PackageEntry;

test('checkLicensePolicy: failOn is violated by any matching license, case-insensitively', () => {
  const v = checkLicensePolicy(
    { 'a:1': entry('GPL-3.0'), 'b:1': entry('(MIT OR GPL-3.0)'), 'c:1': entry('MIT') },
    { failOn: ['gpl-3.0'] },
  );
  assert.deepEqual(
    v.map((x) => [x.package, x.rule]),
    [
      ['a:1', 'failOn'],
      ['b:1', 'failOn'],
    ],
  );
});

test('checkLicensePolicy: onlyAllow needs at least one allowed license; unknown never passes', () => {
  const v = checkLicensePolicy(
    {
      'a:1': entry('MIT'),
      'b:1': entry('(GPL-3.0 OR ISC)'),
      'c:1': entry('GPL-3.0'),
      'd:1': entry('UNKNOWN'),
      'e:1': entry('No information found'),
    },
    { onlyAllow: ['MIT', 'ISC'] },
  );
  assert.deepEqual(
    v.map((x) => x.package),
    ['c:1', 'd:1', 'e:1'],
  );
});

test('checkLicensePolicy: no rules means no violations', () => {
  assert.deepEqual(checkLicensePolicy({ 'a:1': entry('GPL-3.0') }, {}), []);
  assert.deepEqual(
    checkLicensePolicy({ 'a:1': entry('GPL-3.0') }, { failOn: [' '], onlyAllow: [] }),
    [],
  );
});

test('toList accepts arrays and ;-separated strings', () => {
  assert.deepEqual(toList(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(toList('a; b;;c'), ['a', 'b', 'c']);
  assert.deepEqual(toList(undefined), []);
  assert.deepEqual(toList(42), []);
});

test('validateClarificationsFile accepts a good file and rejects checksum/invalid ones', () => {
  const root = makeFixture();
  validateClarificationsFile(writeJson(join(root, 'ok.json'), { 'a@^1': { licenses: 'MIT' } }));
  assert.throws(() => validateClarificationsFile(join(root, 'nope.json')), /Cannot read/);
  assert.throws(
    () => validateClarificationsFile(writeJson(join(root, 'b.json'), { 'a@1': 'MIT' })),
    /must be an object/,
  );
  assert.throws(
    () => validateClarificationsFile(writeJson(join(root, 'c.json'), { 'a@1': { checksum: 'x' } })),
    /checksum/,
  );
});

test('licenseLabel removes only brackets that wrap the whole expression', () => {
  assert.equal(licenseLabel('(MIT OR ISC)'), 'MIT OR ISC');
  assert.equal(licenseLabel('((MIT))'), 'MIT');
  assert.equal(licenseLabel('MIT OR ISC'), 'MIT OR ISC');
  assert.equal(licenseLabel('(MIT OR ISC) AND BSD-3-Clause'), '(MIT OR ISC) AND BSD-3-Clause');
  assert.equal(licenseLabel('(A) OR (B)'), '(A) OR (B)');
  assert.equal(licenseLabel('MIT*'), 'MIT*');
  assert.equal(licenseLabel(' (MIT) '), 'MIT');
  assert.equal(licenseLabel(''), '');
});

test('summarize groups licenses by label, so (MIT OR ISC) and MIT OR ISC are one license', () => {
  const e = (licenses: string, dependencyType: 'direct' | 'transitive') =>
    ({ licenses, dependencyType }) as PackageEntry;
  const s = summarize({
    license: {
      path: '/p',
      packages: {
        a: e('(MIT OR ISC)', 'direct'),
        b: e('MIT OR ISC', 'transitive'),
        c: e('MIT', 'transitive'),
      },
    },
  });
  assert.deepEqual(s.licenses, [
    ['MIT OR ISC', 2],
    ['MIT', 1],
  ]);
  assert.deepEqual([s.total, s.direct, s.transitive], [3, 1, 2]);
});

test('reportDate is YYYY-MM-DD in local time, zero padded', () => {
  assert.equal(reportDate(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.equal(reportDate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('selectFormats: names, "all", case, separators and the legacy isXxx flags combine', () => {
  const names = (o: Parameters<typeof selectFormats>[0]) => selectFormats(o).map((f) => f.label);
  assert.deepEqual(names({}), []);
  assert.deepEqual(
    names({ formats: 'all' }),
    FORMATS.map((f) => f.label),
  );
  assert.deepEqual(names({ formats: ['html', 'csv'] }), ['csv', 'html']); // table order, no duplicates
  assert.deepEqual(names({ formats: 'HTML, csv' as never }), ['csv', 'html']);
  assert.deepEqual(names({ formats: 'markdown;junit' as never }), ['junit', 'markdown']);
  assert.deepEqual(names({ isExcel: true, formats: ['html'] }), ['csv', 'html']); // union
  assert.deepEqual(names({ isHtml: true, formats: ['html'] }), ['html']); // no duplicates
  assert.deepEqual(names({ isJunit: true, isMarkdown: true }), ['junit', 'markdown']);
  assert.deepEqual(names({ formats: [] }), []);
});

test('selectFormats: unknown names fail with the list of valid ones', () => {
  assert.throws(
    () => selectFormats({ formats: ['html', 'xml', 'pdf'] as never }),
    /Unknown format "xml", "pdf"\. Valid formats: csv, html, junit, markdown, all/,
  );
  assert.throws(() => selectFormats({ formats: 'excel' as never }), /Unknown format "excel"/);
});

test('reportTimestamp is a file-name-safe local date and time, zero padded', () => {
  assert.equal(reportTimestamp(new Date(2026, 0, 5, 7, 8, 9)), '2026-01-05_07-08-09');
  assert.equal(reportTimestamp(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31_23-59-59');
});

test('runFolderName is <project>_<timestamp> with only file-system-safe characters', () => {
  const at = new Date(2026, 9, 1, 21, 45, 3);
  assert.equal(runFolderName('my-app', at), 'my-app_2026-10-01_21-45-03');
  assert.equal(runFolderName('@scope/pkg', at), '@scope-pkg_2026-10-01_21-45-03');
  assert.equal(runFolderName('a<b>:c|d?e*f"g\\h/i', at), 'a-b--c-d-e-f-g-h-i_2026-10-01_21-45-03');
  assert.equal(runFolderName('x\u0000y\nz', at), 'x-y-z_2026-10-01_21-45-03'); // control characters
  assert.equal(runFolderName('  ..x..  ', at), 'x_2026-10-01_21-45-03'); // Windows drops these
  assert.equal(runFolderName('', at), 'project_2026-10-01_21-45-03');
  assert.equal(runFolderName('...', at), 'project_2026-10-01_21-45-03');
});

test('createRunFolder creates the parent and never reuses a folder', async () => {
  const parent = join(makeFixture(), 'deep', 'npm_licenses'); // parent does not exist yet
  const a = await createRunFolder(parent, 'run');
  const b = await createRunFolder(parent, 'run');
  const c = await createRunFolder(parent, 'run');
  assert.deepEqual(
    [a, b, c].map((f) => f.slice(parent.length + 1)),
    ['run', 'run-2', 'run-3'],
  );
  assert.ok([a, b, c].every((f) => existsSync(f)));
});

test('createRunFolder is safe for concurrent runs: every caller gets its own folder', async () => {
  const parent = join(makeFixture(), 'npm_licenses');
  const folders = await Promise.all(
    Array.from({ length: 12 }, () => createRunFolder(parent, 'same-second')),
  );
  assert.equal(new Set(folders).size, 12);
  assert.equal(readdirSync(parent).length, 12);
});

test('createRunFolder reports a parent it cannot create instead of looping', async () => {
  const root = makeFixture();
  writeFileSync(join(root, 'npm_licenses'), 'a file, not a folder');
  await assert.rejects(createRunFolder(join(root, 'npm_licenses'), 'run'));
});

// [license expression, policy, expected]
const POLICY_CASES: [string, { failOn?: string[]; onlyAllow?: string[] }, 'ok' | 'violation'][] = [
  // the review's bug: AND means every license applies, so every one must be allowed
  ['MIT OR GPL-3.0', { onlyAllow: ['MIT'] }, 'ok'],
  ['MIT AND GPL-3.0', { onlyAllow: ['MIT'] }, 'violation'],
  ['(MIT AND CC-BY-3.0)', { onlyAllow: ['MIT'] }, 'violation'],
  ['MIT AND GPL-3.0', { onlyAllow: ['MIT', 'GPL-3.0'] }, 'ok'],
  // AND binds tighter than OR; brackets override it
  ['MIT OR ISC AND GPL-3.0', { onlyAllow: ['MIT'] }, 'ok'],
  ['MIT OR ISC AND GPL-3.0', { onlyAllow: ['ISC'] }, 'violation'],
  ['MIT OR ISC AND GPL-3.0', { onlyAllow: ['ISC', 'GPL-3.0'] }, 'ok'],
  ['(MIT OR ISC) AND GPL-3.0', { onlyAllow: ['MIT'] }, 'violation'],
  ['(MIT OR ISC) AND GPL-3.0', { onlyAllow: ['ISC', 'GPL-3.0'] }, 'ok'],
  ['((MIT))', { onlyAllow: ['mit'] }, 'ok'],
  // WITH exceptions, +, markers, case
  ['GPL-2.0 WITH Classpath-exception-2.0', { onlyAllow: ['gpl-2.0'] }, 'ok'],
  ['GPL-2.0 WITH Classpath-exception-2.0', { failOn: ['GPL-2.0'] }, 'violation'],
  ['GPL-2.0+', { onlyAllow: ['GPL-2.0-or-later'] }, 'ok'],
  ['GPL-2.0-or-later', { onlyAllow: ['GPL-2.0+'] }, 'ok'],
  ['BSD*', { onlyAllow: ['BSD'] }, 'ok'],
  ['mit and isc', { onlyAllow: ['MIT'] }, 'violation'],
  // failOn stays conservative: any listed license in the expression counts
  ['MIT OR GPL-3.0', { failOn: ['GPL-3.0'] }, 'violation'],
  ['MIT AND GPL-3.0', { failOn: ['gpl-3.0'] }, 'violation'],
  ['MIT', { failOn: ['GPL-3.0'] }, 'ok'],
  // not an expression: one opaque id, which never matches unless listed exactly
  ['UNKNOWN', { onlyAllow: ['MIT'] }, 'violation'],
  ['No information found', { onlyAllow: ['MIT'] }, 'violation'],
  ['Custom: https://x.io/license', { onlyAllow: ['MIT'] }, 'violation'],
  ['Custom: https://x.io/license', { onlyAllow: ['Custom: https://x.io/license'] }, 'ok'],
  ['MIT AND', { onlyAllow: ['MIT'] }, 'violation'],
  ['(MIT', { onlyAllow: ['MIT'] }, 'violation'],
  ['MIT ISC', { onlyAllow: ['MIT'] }, 'violation'],
  // a guessed licence carries `*` after the whole expression
  ['(MIT OR GPL-3.0)*', { failOn: ['GPL-3.0'] }, 'violation'],
  ['(MIT OR GPL-3.0)*', { onlyAllow: ['MIT'] }, 'ok'],
  ['(MIT AND GPL-3.0)*', { onlyAllow: ['MIT'] }, 'violation'],
];

for (const [license, policy, expected] of POLICY_CASES) {
  test(`policy: "${license}" with ${JSON.stringify(policy)} -> ${expected}`, () => {
    const violations = checkLicensePolicy({ 'x:1': { licenses: license } as PackageEntry }, policy);
    assert.equal(violations.length ? 'violation' : 'ok', expected);
  });
}

test('runFolderName caps a very long name by bytes, on whole characters', () => {
  const at = new Date(2026, 9, 1, 21, 45, 3);
  assert.equal(runFolderName('x'.repeat(400), at), `${'x'.repeat(200)}_2026-10-01_21-45-03`);
  // a file name is limited in BYTES: each emoji is 4, and is never cut in half
  const emoji = runFolderName('🙂'.repeat(200), at);
  assert.equal(emoji, `${'🙂'.repeat(50)}_2026-10-01_21-45-03`);
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.ok(Buffer.byteLength(emoji) < 255, 'fits a file name');
});

test('getDependencies ignores anything that is not a plain name -> range object', () => {
  assert.deepEqual(getDependencies(['x'], 'y').length, 0);
  assert.deepEqual(
    getDependencies({ a: { b: 1 }, c: 5, d: null, e: '^1.0.0' }, undefined).map((d) => d.name),
    ['e'],
  );
  assert.deepEqual(getDependencies(null, 42), []);
});

test('license file names never contain a path separator, whatever a dependency calls itself', () => {
  const hostile = [
    ['a/../../../../tmp/pwn', '1.0.0'],
    ['..\\..\\windows\\system32', '1.0.0'],
    ['pkg', '1.0.0/../../../../etc/cron.d/x'],
    ['pkg', '..\\..\\x'],
    ['C:\\x', '1.0.0'],
    ['a\u0000b', '1\n2'],
  ];
  for (const [name, version] of hostile) {
    const file = licenseFileName({
      'package name': name,
      'package version': version,
    } as PackageEntry);
    // no separator, no drive colon, no control character
    assert.ok(
      Array.from(file).every((ch) => !'\\/:'.includes(ch) && ch.charCodeAt(0) >= 32),
      file,
    );
    // joined onto the output folder it stays one level deep
    assert.equal(dirname(join('/out/licenses', file)), '/out/licenses', file);
  }
  assert.equal(
    licenseFileName({
      'package name': '@babel-code-frame',
      'package version': '7.29.7',
    } as PackageEntry),
    '@babel-code-frame@7.29.7',
  );
});

test('every slash in a scoped or odd package name is flattened in the report', () => {
  const report = getExtendedJson(
    '/p',
    { 'x@1': { name: '@a/b/c', version: '1.0.0', licenses: 'MIT' } },
    [],
  );
  assert.deepEqual(Object.keys(report.license.packages), ['@a-b-c:1.0.0']);
});

test('getDependencies also reads optionalDependencies and peerDependencies, with their own types', () => {
  const deps = getDependencies({ a: '1' }, { b: '2' }, { c: '3' }, { d: '4' });
  assert.deepEqual(
    deps.map((d) => [d.name, d.type]),
    [
      ['a', 'dependency'],
      ['b', 'devDependency'],
      ['c', 'optionalDependency'],
      ['d', 'peerDependency'],
    ],
  );
});
