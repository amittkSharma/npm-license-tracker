import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CSV_PACKAGE_MANAGER_COLUMNS } from '../src/formats';
import { LicensePolicyError, run } from '../src/index';
import { makeFixture, parseCsv, patchPackage, runDir, writeJson } from './helpers';

const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ['--import', 'tsx', 'bin/npm-tracker.ts', ...args]);
// run() is fire-and-forget (as is the CSV write), so wait for the files
const waitFor = async (file: string) => {
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
};

test('CLI writes JSON, CSV and license files', async () => {
  const root = makeFixture();
  const { stdout } = await cli('--path', root, '--isExcel');
  const out = runDir(root);
  assert.match(stdout, /Paths to traverse:- /);
  assert.match(stdout, /Total licenses file copied successfully: 3 and failed:1 :/);
  await waitFor(join(out, 'npm_licenses.csv'));

  const report = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8'));
  assert.equal(report.license.path, root);
  const pk = report.license.packages;
  // the project itself (fx@1.0.0) is not listed
  assert.deepEqual(Object.keys(pk).sort(), [
    '@sc-bar:2.0.0',
    'baz:3.0.0',
    'foo:1.0.0',
    'foo:2.0.0',
  ]);
  assert.equal(pk['foo:1.0.0'].dependencyType, 'direct');
  assert.equal(pk['foo:2.0.0'].dependencyType, 'transitive');
  // real author data survives instead of a placeholder
  assert.equal(pk['foo:1.0.0'].publisher, 'Ann');
  assert.equal(pk['foo:1.0.0']['publisher contact information'], 'ann@x.io');
  assert.equal(pk['foo:1.0.0'].description, 'foo, pkg');
  // missing data falls back to repo-derived values or the standard message
  assert.equal(pk['@sc-bar:2.0.0'].publisher, 'acme');
  assert.equal(pk['@sc-bar:2.0.0']['publisher contact information'], 'https://github.com/acme/bar');
  assert.equal(pk['@sc-bar:2.0.0'].description, 'No information found');
  assert.equal(pk['baz:3.0.0'].publisher, 'No information found');
  assert.equal(pk['@sc-bar:2.0.0']['license file'], 'none');
  assert.equal(pk['baz:3.0.0'].licenses, 'Apache-2.0');
  assert.ok(!JSON.stringify(report).includes('<<Default'));

  const csv = readFileSync(join(out, 'npm_licenses.csv'), 'utf8').split('\n');
  assert.equal(
    csv[0],
    '"package name","licenses","download url","license file","publisher","description","programming language","package version","publisher contact information","dependencyType","package manager","package manager version"',
  );
  assert.equal(csv.length, 5); // header + 4 packages
  assert.ok(!csv.join('').includes('<<Default'));

  // reports live in the root; license files are in the licenses/ sub-folder, named <name>@<version>
  assert.deepEqual(readdirSync(out).sort(), ['licenses', 'npm_licenses.csv', 'npm_licenses.json']);
  const lic = join(out, 'licenses');
  assert.deepEqual(readdirSync(lic).sort(), ['baz@3.0.0', 'foo@1.0.0', 'foo@2.0.0']); // @sc/bar has no license file
  assert.equal(readFileSync(join(lic, 'foo@1.0.0'), 'utf8'), 'MIT foo');
  assert.equal(readFileSync(join(lic, 'foo@2.0.0'), 'utf8'), 'MIT foo two'); // both versions of foo kept
  assert.equal(readFileSync(join(lic, 'baz@3.0.0'), 'utf8'), 'Apache baz');
  // several licenses are one string, never an array
  assert.equal(pk['foo:2.0.0'].licenses, 'MIT OR ISC');
  for (const entry of Object.values(pk) as { licenses: unknown }[]) {
    assert.equal(typeof entry.licenses, 'string');
  }
});

test('JSON and CSV carry exactly the same properties and values', async () => {
  const root = makeFixture();
  await cli('--path', root, '--isExcel');
  const out = runDir(root);
  await waitFor(join(out, 'npm_licenses.csv'));

  const packages = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8')).license
    .packages;
  const [header, ...rows] = parseCsv(readFileSync(join(out, 'npm_licenses.csv'), 'utf8'));
  const entries = Object.values(packages) as Record<string, string>[];

  assert.equal(rows.length, entries.length);
  for (const entry of entries) {
    // same property names, same order, plus the two package-manager columns a flat file needs
    assert.deepEqual(header, [...Object.keys(entry), ...CSV_PACKAGE_MANAGER_COLUMNS]);
  }
  const csvRows = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  const pm = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8')).license
    .packageManager;
  for (const row of csvRows) {
    assert.equal(row['package manager'], pm.name);
    assert.equal(row['package manager version'], pm.version ?? pm.versionHint ?? '');
  }
  assert.deepEqual(
    [...csvRows]
      .map(({ 'package manager': _a, 'package manager version': _b, ...fields }) => fields)
      .sort((a, b) =>
        `${a['package name']}${a['package version']}`.localeCompare(
          `${b['package name']}${b['package version']}`,
        ),
      ),
    [...entries].sort((a, b) =>
      `${a['package name']}${a['package version']}`.localeCompare(
        `${b['package name']}${b['package version']}`,
      ),
    ),
  );
  const types = Object.fromEntries(
    csvRows.map((r) => [`${r['package name']}:${r['package version']}`, r.dependencyType]),
  );
  assert.deepEqual(types, {
    '@sc-bar:2.0.0': 'direct',
    'baz:3.0.0': 'direct',
    'foo:1.0.0': 'direct',
    'foo:2.0.0': 'transitive',
  });
});

test('dependencyType is right for any version range style', async () => {
  const root = makeFixture({
    dependencies: { foo: '~1.0.0', '@sc/bar': '>=1.0.0' },
    devDependencies: { baz: 'latest' },
  });
  await cli('--path', root);
  const packages = JSON.parse(readFileSync(join(runDir(root), 'npm_licenses.json'), 'utf8')).license
    .packages;
  const types = Object.fromEntries(
    Object.entries(packages).map(([k, v]) => [k, (v as { dependencyType: string }).dependencyType]),
  );
  assert.deepEqual(types, {
    '@sc-bar:2.0.0': 'direct',
    'baz:3.0.0': 'direct',
    'foo:1.0.0': 'direct',
    'foo:2.0.0': 'transitive', // nested copy pulled in by baz, not the declared one
  });
});

test('CLI works for a project without devDependencies or name/version', async () => {
  const root = makeFixture({ devDependencies: undefined, name: undefined, version: undefined });
  const { stdout } = await cli('--path', root);
  assert.match(stdout, /JSON file is created/);
  const report = JSON.parse(readFileSync(join(runDir(root), 'npm_licenses.json'), 'utf8'));
  assert.equal(report.license.packages['baz:3.0.0'].dependencyType, 'transitive');
});

test('CLI exits 1 with a clear message when package.json cannot be read', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'nlt-empty-'));
  await assert.rejects(cli('--path', empty), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Error: Not able to read the package file/);
    return true;
  });
});

test('CLI exits 1 when the output cannot be written', async () => {
  const root = makeFixture();
  writeFileSync(join(root, 'npm_licenses'), 'a file where the output folder should be');
  await assert.rejects(cli('--path', root), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /not able to write the file/);
    return true;
  });
});

test('CLI skips CSV without --isExcel', async () => {
  const root = makeFixture();
  await cli('--path', root);
  const out = runDir(root);
  await waitFor(join(out, 'npm_licenses.json'));
  assert.equal(existsSync(join(out, 'npm_licenses.csv')), false);
});

test('CLI exits 1 when --path is missing', async () => {
  await assert.rejects(cli(), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /--path is required/);
    return true;
  });
});

test('programmatic API: run() resolves after writing, rejects on failure', async () => {
  const root = makeFixture();
  await run({ path: root });
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.json')));
  await assert.rejects(run({ path: join(root, 'missing') }), /Not able to read the package file/);
});

test('programmatic API: run() rejects when no path is given', async () => {
  await assert.rejects(run(undefined as never), /module stopped working: No path is provided/);
  await assert.rejects(run({} as never), /No path is provided/);
  await assert.rejects(run({ path: '' }), /No path is provided/);
});

const packagesOf = (root: string) =>
  JSON.parse(readFileSync(join(runDir(root), 'npm_licenses.json'), 'utf8')).license.packages;
const keysOf = (root: string) => Object.keys(packagesOf(root)).sort();

test('--production skips devDependencies and what only they pull in', async () => {
  const root = makeFixture();
  await cli('--path', root, '--production');
  // baz is a devDependency; foo@2.0.0 is nested inside baz
  assert.deepEqual(keysOf(root), ['@sc-bar:2.0.0', 'foo:1.0.0']);
});

test('--excludePrivatePackages skips packages marked private', async () => {
  const root = makeFixture();
  patchPackage(root, 'baz', { private: true });
  await cli('--path', root, '--excludePrivatePackages');
  assert.deepEqual(keysOf(root), ['@sc-bar:2.0.0', 'foo:1.0.0', 'foo:2.0.0']);
});

test('--excludePackages accepts name, name@major and name@version', async () => {
  const root = makeFixture();
  await cli('--path', root, '--excludePackages', 'baz;foo@2');
  assert.deepEqual(keysOf(root), ['@sc-bar:2.0.0', 'foo:1.0.0']);
  const exact = makeFixture();
  await cli('--path', exact, '--excludePackages', 'foo@1.0.0');
  assert.deepEqual(keysOf(exact), ['@sc-bar:2.0.0', 'baz:3.0.0', 'foo:2.0.0']);
});

test('--clarificationsFile overrides the detected license', async () => {
  const root = makeFixture();
  const file = writeJson(join(root, 'clarifications.json'), { 'baz@3.0.0': { licenses: 'MIT' } });
  await cli('--path', root, '--clarificationsFile', file);
  assert.equal(packagesOf(root)['baz:3.0.0'].licenses, 'MIT');
  assert.equal(packagesOf(root)['foo:1.0.0'].licenses, 'MIT'); // untouched
});

test('--clarificationsFile rejects bad files with a clear message, before scanning', async () => {
  const root = makeFixture();
  const bad = [
    [join(root, 'missing.json'), /Cannot read clarifications file/],
    [writeJson(join(root, 'array.json'), []), /must be a JSON object/],
    [
      writeJson(join(root, 'checksum.json'), { 'baz@3.0.0': { licenses: 'MIT', checksum: 'abc' } }),
      /"checksum", which is not supported/,
    ],
  ] as const;
  for (const [file, message] of bad) {
    await assert.rejects(
      cli('--path', root, '--clarificationsFile', file),
      (err: { code: number; stderr: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, message);
        return true;
      },
    );
  }
  assert.equal(existsSync(join(root, 'npm_licenses')), false);
});

test('--failOn exits 1 but still writes the full report', async () => {
  const root = makeFixture();
  await assert.rejects(
    cli('--path', root, '--failOn', 'apache-2.0'),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /License policy violated by 1 package/);
      assert.match(err.stderr, /baz:3\.0\.0 \(Apache-2\.0\)/);
      return true;
    },
  );
  assert.equal(keysOf(root).length, 4); // report is complete
});

test('--failOn treats dual licenses conservatively', async () => {
  const root = makeFixture();
  await assert.rejects(cli('--path', root, '--failOn', 'ISC'), (err: { stderr: string }) => {
    assert.match(err.stderr, /2 package/);
    assert.match(err.stderr, /@sc-bar:2\.0\.0 \(ISC\)/);
    assert.match(err.stderr, /foo:2\.0\.0 \(MIT OR ISC\)/);
    return true;
  });
});

test('--onlyAllow passes when every package has an allowed license, else exits 1', async () => {
  const ok = makeFixture();
  await cli('--path', ok, '--onlyAllow', 'MIT;ISC;Apache-2.0');
  const root = makeFixture();
  await assert.rejects(
    cli('--path', root, '--onlyAllow', 'MIT;ISC'),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /baz:3\.0\.0 \(Apache-2\.0\)/);
      assert.doesNotMatch(err.stderr, /foo:/);
      return true;
    },
  );
});

test('options are additive: without them the report is the full one', async () => {
  const root = makeFixture();
  await cli('--path', root);
  assert.deepEqual(keysOf(root), ['@sc-bar:2.0.0', 'baz:3.0.0', 'foo:1.0.0', 'foo:2.0.0']);
});

test('--help lists the new options', async () => {
  const { stdout } = await cli('--help');
  for (const flag of [
    '--isExcel',
    '--isHtml',
    '--isJunit',
    '--isMarkdown',
    '--format',
    '--production',
    '--excludePrivatePackages',
    '--excludePackages',
    '--clarificationsFile',
    '--failOn',
    '--onlyAllow',
  ]) {
    assert.match(stdout, new RegExp(flag));
  }
});

test('programmatic API: policy failures reject with a LicensePolicyError carrying the violations', async () => {
  const root = makeFixture();
  await assert.rejects(run({ path: root, failOn: ['Apache-2.0'] }), (err) => {
    assert.ok(err instanceof LicensePolicyError);
    assert.deepEqual(err.violations, [
      { package: 'baz:3.0.0', licenses: 'Apache-2.0', rule: 'failOn' },
    ]);
    return true;
  });
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.json')));
  // a ';'-separated string (what the CLI passes) works too
  const root2 = makeFixture();
  await assert.rejects(run({ path: root2, onlyAllow: 'MIT' as never }), LicensePolicyError);
});

test('programmatic API: scan options work without the CLI', async () => {
  const root = makeFixture();
  await run({ path: root, production: true, excludePackages: ['@sc/bar'] });
  assert.deepEqual(keysOf(root), ['foo:1.0.0']);
});

const reportFiles = (root: string) =>
  readdirSync(runDir(root))
    .filter((f) => f !== 'licenses')
    .sort();
const ALL_FILES = [
  'npm_licenses.csv',
  'npm_licenses.html',
  'npm_licenses.json',
  'npm_licenses.junit.xml',
  'npm_licenses.md',
];

test('--format all writes every report', async () => {
  const root = makeFixture();
  await cli('--path', root, '--format', 'all');
  assert.deepEqual(reportFiles(root), ALL_FILES);
  assert.ok(existsSync(join(runDir(root), 'licenses', 'foo@1.0.0')));
});

test('--format takes a comma list, in any case, and combines with the isXxx flags', async () => {
  const a = makeFixture();
  await cli('--path', a, '--format', 'html,CSV');
  assert.deepEqual(reportFiles(a), ['npm_licenses.csv', 'npm_licenses.html', 'npm_licenses.json']);
  const b = makeFixture();
  await cli('--path', b, '--format', 'markdown', '--isJunit');
  assert.deepEqual(reportFiles(b), [
    'npm_licenses.json',
    'npm_licenses.junit.xml',
    'npm_licenses.md',
  ]);
});

test('--format with an unknown name fails fast, before scanning or writing anything', async () => {
  const root = makeFixture();
  await assert.rejects(
    cli('--path', root, '--format', 'html,xml'),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(
        err.stderr,
        /Unknown format "xml"\. Valid formats: csv, html, junit, markdown, all/,
      );
      return true;
    },
  );
  assert.equal(existsSync(join(root, 'npm_licenses')), false);
});

test('API: formats accepts "all" or a list', async () => {
  const a = makeFixture();
  await run({ path: a, formats: 'all' });
  assert.deepEqual(reportFiles(a), ALL_FILES);
  const b = makeFixture();
  await run({ path: b, formats: ['markdown'] });
  assert.deepEqual(reportFiles(b), ['npm_licenses.json', 'npm_licenses.md']);
  await assert.rejects(
    run({ path: makeFixture(), formats: ['nope'] as never }),
    /Unknown format "nope"/,
  );
});

const RUN_FOLDER = /^fx_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/;

test('every run writes into a new <package>_<datetime> folder inside npm_licenses/', async () => {
  const root = makeFixture();
  const first = await cli('--path', root, '--format', 'html');
  const firstDir = runDir(root);
  assert.match(basename(firstDir), RUN_FOLDER);
  assert.equal(dirname(firstDir), join(root, 'npm_licenses'));
  assert.match(first.stdout, new RegExp(`Output folder:.*${basename(firstDir)}`));
  assert.deepEqual(readdirSync(firstDir).sort(), [
    'licenses',
    'npm_licenses.html',
    'npm_licenses.json',
  ]);
  const before = readFileSync(join(firstDir, 'npm_licenses.json'), 'utf8');

  await new Promise((r) => setTimeout(r, 1100)); // a different second
  await cli('--path', root, '--format', 'markdown');
  const runs = readdirSync(join(root, 'npm_licenses')).sort();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => RUN_FOLDER.test(r)));
  // the first run is untouched: same files, nothing from the second run mixed in
  assert.equal(readFileSync(join(firstDir, 'npm_licenses.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(firstDir).sort(), [
    'licenses',
    'npm_licenses.html',
    'npm_licenses.json',
  ]);
  assert.deepEqual(readdirSync(runDir(root)).sort(), [
    'licenses',
    'npm_licenses.json',
    'npm_licenses.md',
  ]);
});

test('runs in the same second still get separate folders (nothing is overwritten)', async () => {
  const root = makeFixture();
  const results = await Promise.all([
    run({ path: root }),
    run({ path: root }),
    run({ path: root }),
  ]);
  const folders = results.map((r) => r.outputFolder);
  assert.equal(new Set(folders).size, 3);
  for (const folder of folders) {
    assert.ok(existsSync(join(folder, 'npm_licenses.json')), folder);
    assert.ok(existsSync(join(folder, 'licenses', 'foo@1.0.0')), folder);
  }
});

test('API: run() resolves with the absolute output folder', async () => {
  const root = makeFixture();
  const { outputFolder } = await run({ path: root, formats: ['markdown'] });
  assert.ok(isAbsolute(outputFolder));
  assert.equal(outputFolder, runDir(root));
  assert.ok(existsSync(join(outputFolder, 'npm_licenses.md')));
  // a relative project path still gives an absolute folder
  const rel = relative(process.cwd(), root);
  const again = await run({ path: rel });
  assert.ok(isAbsolute(again.outputFolder));
  assert.equal(dirname(again.outputFolder), join(root, 'npm_licenses'));
});

test('the folder name uses the project name: scoped names are flattened, unnamed projects use their directory', async () => {
  const scoped = makeFixture({ name: '@acme/tool' });
  assert.match(basename((await run({ path: scoped })).outputFolder), /^@acme-tool_\d{4}-/);
  const unnamed = makeFixture({ name: undefined, version: undefined });
  const { outputFolder } = await run({ path: unnamed });
  assert.ok(basename(outputFolder).startsWith(`${basename(unnamed)}_`));
});

test('a policy failure still reports where the reports were written', async () => {
  const root = makeFixture();
  await assert.rejects(
    run({ path: root, failOn: ['Apache-2.0'], formats: ['markdown'] }),
    (err) => {
      assert.ok(err instanceof LicensePolicyError);
      assert.equal(err.outputFolder, runDir(root));
      assert.ok(existsSync(join(err.outputFolder as string, 'npm_licenses.md')));
      return true;
    },
  );
});

test('the JSON still records the project path, and a failed run creates no folder', async () => {
  const root = makeFixture();
  await run({ path: root });
  const json = JSON.parse(readFileSync(join(runDir(root), 'npm_licenses.json'), 'utf8'));
  assert.equal(json.license.path, root);
  const empty = mkdtempSync(join(tmpdir(), 'nlt-empty-'));
  await assert.rejects(run({ path: empty }), /Not able to read the package file/);
  assert.equal(existsSync(join(empty, 'npm_licenses')), false);
});

test('--outputDir keeps the scanned project untouched and puts the run folder where asked', async () => {
  const root = makeFixture();
  const target = join(mkdtempSync(join(tmpdir(), 'nlt-out-')), 'results', 'deep');
  const { stdout } = await cli('--path', root, '--outputDir', target, '--format', 'markdown');
  assert.equal(
    existsSync(join(root, 'npm_licenses')),
    false,
    'nothing is written into the project',
  );
  const runs = readdirSync(target);
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^fx_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/);
  assert.deepEqual(readdirSync(join(target, runs[0])).sort(), [
    'licenses',
    'npm_licenses.json',
    'npm_licenses.md',
  ]);
  assert.match(stdout, new RegExp(`Output folder:.*${runs[0]}`));
  const { outputFolder } = await run({ path: root, outputDir: target });
  assert.equal(join(target, basename(outputFolder)), outputFolder);
  assert.equal(existsSync(join(root, 'npm_licenses')), false);
});

test('--outputDir that cannot be created fails clearly', async () => {
  const root = makeFixture();
  const blocker = join(mkdtempSync(join(tmpdir(), 'nlt-out-')), 'file');
  writeFileSync(blocker, 'a file, not a folder');
  await assert.rejects(
    cli('--path', root, '--outputDir', join(blocker, 'x')),
    (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /not able to write the file/);
      return true;
    },
  );
});

test('a package.json that is not a JSON object fails cleanly, with no stack trace', async () => {
  for (const content of ['"text"', '123', 'true', '[]', 'null', '', '{ not json']) {
    const root = mkdtempSync(join(tmpdir(), 'nlt-bad-'));
    writeFileSync(join(root, 'package.json'), content);
    await assert.rejects(cli('--path', root), (err: { code: number; stderr: string }) => {
      assert.equal(err.code, 1, content);
      assert.match(err.stderr, /^Error: Not able to read the package file/m, content);
      assert.doesNotMatch(err.stderr, /Caught exception|\n\s+at /, content);
      return true;
    });
  }
});

test('a project with nothing to scan gives an empty report, whatever its name', async () => {
  for (const name of ['My App', 'ünï 名前 🙂', '..', '', undefined]) {
    const root = mkdtempSync(join(tmpdir(), 'nlt-zero-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    const { outputFolder } = await run({ path: root, formats: 'all' });
    const report = JSON.parse(
      readFileSync(join(outputFolder, 'npm_licenses.json'), 'utf8'),
    ).license;
    assert.deepEqual(report.packages, {}, String(name));
    assert.deepEqual(
      readdirSync(outputFolder).sort(), // nothing to copy, so no licenses/ folder
      [
        'npm_licenses.csv',
        'npm_licenses.html',
        'npm_licenses.json',
        'npm_licenses.junit.xml',
        'npm_licenses.md',
      ],
      String(name),
    );
  }
  // ... but declared dependencies that are missing are still reported, even if the project name is odd
  const root = mkdtempSync(join(tmpdir(), 'nlt-zero-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'My App', version: '1.0.0', dependencies: { lodash: '4.17.21' } }),
  );
  await assert.rejects(run({ path: root }), /Not installed:\n\s+- lodash/);
});

test('a 400-character project name still produces a valid run folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nlt-long-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x'.repeat(400), version: '1.0.0' }),
  );
  const { outputFolder } = await run({ path: root });
  assert.ok(Buffer.byteLength(basename(outputFolder)) < 255, 'a valid file name');
  assert.ok(existsSync(join(outputFolder, 'npm_licenses.json')));
});
