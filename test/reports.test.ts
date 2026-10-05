import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  CSV_PACKAGE_MANAGER_COLUMNS,
  FORMATS,
  type Format,
  neutralizeFormula,
} from '../src/formats';
import { renderHtmlReport } from '../src/html-report';
import { run } from '../src/index';
import { renderJUnitReport } from '../src/junit-report';
import { renderMarkdownReport } from '../src/markdown-report';
import { planLicenseFiles, writeReports } from '../src/npm-license-tracker';
import { REPORT_FIELDS } from '../src/report-model';
import type { LicenseReport, PackageEntry } from '../src/types';
import {
  makeFixture,
  parseCsv,
  parseHtml,
  parseJUnit,
  parseMarkdown,
  patchPackage,
  runDir,
} from './helpers';

const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ['--import', 'tsx', 'bin/npm-tracker.ts', ...args]);
// local noon, so the local calendar date is 2026-01-15 in every time zone
const when = new Date(2026, 0, 15, 12, 0, 0);
const meta = { projectName: 'my-app', generatedAt: when };

const entry = (over: Partial<PackageEntry> = {}): PackageEntry => ({
  'package name': 'pkg',
  licenses: 'MIT',
  'download url': 'https://github.com/acme/pkg',
  'license file': '/p/node_modules/pkg/LICENSE',
  publisher: 'acme',
  description: 'A package',
  'programming language': 'JavaScript',
  'package version': '1.0.0',
  'publisher contact information': 'https://github.com/acme/pkg',
  dependencyType: 'direct',
  ...over,
});
const reportOf = (...entries: PackageEntry[]): LicenseReport => ({
  license: {
    path: '/home/dev/secret-project',
    packages: Object.fromEntries(
      entries.map((e) => [`${e['package name']}:${e['package version']}`, e]),
    ),
  },
});

test('REPORT_FIELDS lists every PackageEntry property exactly once, in JSON order', () => {
  assert.deepEqual(REPORT_FIELDS, Object.keys(entry()));
});

test('HTML: escapes hostile package metadata and only links http(s) URLs', () => {
  const evil = entry({
    'package name': '<img src=x onerror=alert(1)>',
    description: '<script>alert(1)</script> "quoted" & \'single\'',
    'download url': 'javascript:alert(1)',
    publisher: '"><script>alert(2)</script>',
    licenses: '"><b>x</b>',
  });
  const html = renderHtmlReport(reportOf(evil), meta);
  assert.ok(!html.includes('<script>alert'), 'script tag from metadata must not appear');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(!/href="javascript:/i.test(html), 'javascript: must not become a link');
  // the data still round-trips exactly
  const [row] = parseHtml(html).rows;
  assert.equal(row.description, evil.description);
  assert.equal(row['package name'], evil['package name']);
  assert.equal(row['download url'], 'javascript:alert(1)');
  // a real URL is a safe link
  const ok = renderHtmlReport(reportOf(entry()), meta);
  assert.match(
    ok,
    /<a href="https:\/\/github\.com\/acme\/pkg" target="_blank" rel="noopener noreferrer">/,
  );
});

test('HTML: same columns as the JSON, summary numbers, no external requests', () => {
  const html = renderHtmlReport(
    reportOf(
      entry(),
      entry({ 'package name': 'b', licenses: 'ISC', dependencyType: 'transitive' }),
    ),
    meta,
  );
  const { header, rows } = parseHtml(html);
  assert.deepEqual(header, Object.keys(entry()));
  assert.equal(rows.length, 2);
  assert.match(html, /<b>2<\/b><span>packages<\/span>/);
  assert.match(html, /<b>1<\/b><span>direct<\/span>/);
  assert.match(html, /<b>2<\/b><span>distinct licenses<\/span>/);
  assert.match(html, /<h1>License Report for my-app<\/h1>/);
  assert.match(html, /<title>License Report for my-app<\/title>/);
  assert.match(html, /<p class="sub">Date: 2026-01-15<\/p>/);
  assert.doesNotMatch(html, /generated 20/);
  assert.ok(!headerOfHtml(html).includes('secret-project'), 'no project path under the header');
  // nothing is loaded from outside (the drawer's iframe starts as about:blank)
  assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]*\s(src|href)="(?!about:blank)/i);
});

test('HTML: shows policy violations and flags the rows', () => {
  const html = renderHtmlReport(reportOf(entry(), entry({ 'package name': 'b' })), {
    ...meta,
    violations: [{ package: 'b:1.0.0', licenses: 'MIT', rule: 'failOn' }],
  });
  assert.match(html, /License policy violated by 1 package\(s\)/);
  assert.equal(parseHtml(html).violating, 1);
});

test('HTML: an empty report still renders', () => {
  const html = renderHtmlReport(reportOf(), meta);
  assert.equal(parseHtml(html).rows.length, 0);
  assert.match(html, /<b>0<\/b><span>packages<\/span>/);
});

test('JUnit: counts, failures and a stable structure', () => {
  const xml = renderJUnitReport(
    reportOf(entry(), entry({ 'package name': 'b', licenses: 'GPL-3.0' })),
    {
      ...meta,
      violations: [{ package: 'b:1.0.0', licenses: 'GPL-3.0', rule: 'failOn' }],
    },
  );
  const parsed = parseJUnit(xml);
  assert.deepEqual([parsed.tests, parsed.failures, parsed.errors], [2, 1, 0]);
  assert.deepEqual(
    parsed.cases.map((c) => [c.name, c.classname, c.failed]),
    [
      ['pkg@1.0.0', 'MIT', false],
      ['b@1.0.0', 'GPL-3.0', true],
    ],
  );
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes(`timestamp="${when.toISOString()}"`));
  assert.equal((xml.match(/<failure /g) ?? []).length, 1);
  assert.match(
    xml,
    /<failure message="not allowed by the onlyAllow list|license is on the failOn list: GPL-3\.0" type="LicensePolicyViolation">/,
  );
});

test('JUnit: every field of every entry is listed, in report order', () => {
  const { cases } = parseJUnit(renderJUnitReport(reportOf(entry()), meta));
  assert.deepEqual(
    cases[0].fields.map(([k]) => k),
    REPORT_FIELDS,
  );
  assert.deepEqual(Object.fromEntries(cases[0].fields), entry());
});

test('JUnit: escapes markup, drops characters XML forbids, keeps values on one line', () => {
  const hostile = entry({
    'package name': 'a&b',
    description: 'x <y> "z" \'w\' ]]> \u0000\u0008\u000b￿ line1\nline2',
    licenses: 'MIT" onload="x',
  });
  const xml = renderJUnitReport(reportOf(hostile), meta);
  // no forbidden control characters survive, and nothing breaks out of an attribute
  for (const ch of ['\u0000', '\u0008', '\u000b', '￿']) assert.ok(!xml.includes(ch));
  assert.ok(!xml.includes('classname="MIT" onload'));
  const { cases } = parseJUnit(xml);
  const fields = Object.fromEntries(cases[0].fields);
  assert.equal(fields.description, 'x <y> "z" \'w\' ]]>  line1 line2');
  assert.equal(fields['package name'], 'a&b');
  assert.equal(cases[0].classname, 'MIT" onload="x');
});

test('JUnit: an empty report is a valid, empty suite', () => {
  const parsed = parseJUnit(renderJUnitReport(reportOf(), meta));
  assert.deepEqual([parsed.tests, parsed.failures, parsed.cases.length], [0, 0, 0]);
});

test('Markdown: escapes markup and table syntax, links only http(s) URLs, round-trips every value', () => {
  const evil = entry({
    'package name': '<img src=x onerror=alert(1)> | pipe',
    description:
      '# not a heading | a|b `code` *bold* _it_ [x](javascript:alert(1)) <b>y</b> & ~~s~~ back\\slash\nline2',
    'download url': 'javascript:alert(1)',
    licenses: 'MIT | ISC',
  });
  const md = renderMarkdownReport(reportOf(evil, entry({ 'package name': 'ok' })), {
    ...meta,
  });
  // nothing in the data can form markup of its own: every special character is backslash-escaped
  // (`\<img` is fine: the backslash makes it literal text)
  // the package table holds the data (the summary above it has our own <b>)
  const data = md.split('## Packages')[1];
  assert.ok(!/(^|[^\\])<img/.test(data), 'raw html tag');
  assert.ok(!/(^|[^\\])<b>/.test(data), 'raw html tag');
  assert.ok(!data.includes('[x]('), 'link syntax');
  assert.ok(!/(^|[^\\])\*bold\*/.test(data), 'emphasis');
  const { header, rows } = parseMarkdown(md);
  assert.deepEqual(header, REPORT_FIELDS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['package name'], evil['package name']);
  assert.equal(rows[0].description, evil.description?.replace('\n', ' '));
  assert.equal(rows[0].licenses, 'MIT | ISC');
  assert.equal(rows[0]['download url'], 'javascript:alert(1)');
  // a real URL is an autolink
  assert.match(md, /\| <https:\/\/github\.com\/acme\/pkg> \|/);
  assert.equal(rows[1]['download url'], 'https://github.com/acme/pkg');
});

test('Markdown: summary, license table, violations and an empty report', () => {
  const md = renderMarkdownReport(
    reportOf(
      entry(),
      entry({ 'package name': 'b', licenses: 'GPL-3.0', dependencyType: 'transitive' }),
    ),
    {
      ...meta,
      violations: [{ package: 'b:1.0.0', licenses: 'GPL-3.0', rule: 'failOn' }],
    },
  );
  assert.match(md, /^# License Report for my-app\n\nDate: 2026-01-15\n/);
  assert.doesNotMatch(md, /generated/);
  assert.ok(!headerOfMd(md).includes('secret-project'), 'no project path under the header');
  assert.match(md, /- \*\*Packages:\*\* 2 \(1 direct, 1 transitive\)/);
  assert.match(md, /- \*\*Policy violations:\*\* 1/);
  assert.match(
    md,
    /## License policy violated by 1 package\(s\)\n- \*\*b:1\.0\.0\*\* \(GPL-3\.0\): license is on the failOn list/,
  );
  assert.match(md, /\| MIT \| 1 \|/);
  const empty = renderMarkdownReport(reportOf(), meta);
  assert.equal(parseMarkdown(empty).rows.length, 0);
  assert.doesNotMatch(empty, /policy violated/);
});

test('every format in FORMATS is wired: its option writes exactly npm_licenses.<extension>', async () => {
  assert.equal(new Set(FORMATS.map((f) => f.extension)).size, FORMATS.length);
  for (const format of FORMATS) {
    const root = makeFixture();
    await run({ path: root, [format.option]: true });
    const files = readdirSync(runDir(root)).filter((f) => f !== 'licenses');
    assert.deepEqual(
      files.sort(),
      [`npm_licenses.${format.extension}`, 'npm_licenses.json'].sort(),
      format.option,
    );
  }
});

test('CLI: JSON, CSV, HTML, JUnit and Markdown carry identical fields and values', async () => {
  const root = makeFixture();
  patchPackage(root, 'foo', { description: 'foo <b>pkg</b> & "q" \'s' });
  patchPackage(root, 'baz/node_modules/foo', { description: 'two\nlines' });
  await cli('--path', root, '--isExcel', '--isHtml', '--isJunit', '--isMarkdown');
  const out = runDir(root);
  for (const f of [
    'npm_licenses.csv',
    'npm_licenses.html',
    'npm_licenses.junit.xml',
    'npm_licenses.md',
  ]) {
    for (let i = 0; i < 100 && !existsSync(join(out, f)); i++)
      await new Promise((r) => setTimeout(r, 50));
  }

  const json = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8')).license
    .packages as Record<string, PackageEntry>;
  const keys = Object.keys(json);
  assert.equal(keys.length, 4);

  const [csvHeader, ...csvRows] = parseCsv(readFileSync(join(out, 'npm_licenses.csv'), 'utf8'));
  const html = parseHtml(readFileSync(join(out, 'npm_licenses.html'), 'utf8'));
  const junit = parseJUnit(readFileSync(join(out, 'npm_licenses.junit.xml'), 'utf8'));
  const md = parseMarkdown(readFileSync(join(out, 'npm_licenses.md'), 'utf8'));
  assert.deepEqual(csvHeader, [...REPORT_FIELDS, ...CSV_PACKAGE_MANAGER_COLUMNS]);
  assert.deepEqual(md.header, REPORT_FIELDS);
  assert.deepEqual(html.header, REPORT_FIELDS);
  assert.deepEqual(
    [csvRows.length, html.rows.length, junit.cases.length, junit.tests, md.rows.length],
    [4, 4, 4, 4, 4],
  );

  keys.forEach((key, i) => {
    for (const [f, field] of REPORT_FIELDS.entries()) {
      const expected = String(json[key][field]);
      assert.equal(csvRows[i][f], expected, `csv ${key} ${field}`);
      assert.equal(html.rows[i][field], expected, `html ${key} ${field}`);
      // Markdown also shows one value per line
      assert.equal(
        md.rows[i][field],
        expected.replace(/\s*[\r\n]+\s*/g, ' '),
        `markdown ${key} ${field}`,
      );
      // JUnit lists one line per field: line breaks inside a value become a space
      assert.equal(
        Object.fromEntries(junit.cases[i].fields)[field],
        expected.replace(/\s*[\r\n]+\s*/g, ' '),
        `junit ${key} ${field}`,
      );
    }
    assert.deepEqual(
      junit.cases[i].fields.map(([k]) => k),
      REPORT_FIELDS,
    );
  });
  assert.equal(json['foo:1.0.0'].description, 'foo <b>pkg</b> & "q" \'s'); // the awkward value was really in play
});

test('CLI: HTML and JUnit are only written when asked for', async () => {
  const root = makeFixture();
  await cli('--path', root);
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.json')));
  assert.equal(existsSync(join(runDir(root), 'npm_licenses.html')), false);
  assert.equal(existsSync(join(runDir(root), 'npm_licenses.junit.xml')), false);
  assert.equal(existsSync(join(runDir(root), 'npm_licenses.md')), false);
});

test('CLI: a policy failure still writes HTML and JUnit, with the failures marked', async () => {
  const root = makeFixture();
  await assert.rejects(
    cli('--path', root, '--isHtml', '--isJunit', '--isMarkdown', '--failOn', 'Apache-2.0'),
    (err: { code: number }) => err.code === 1,
  );
  const out = runDir(root);
  const junit = parseJUnit(readFileSync(join(out, 'npm_licenses.junit.xml'), 'utf8'));
  assert.deepEqual([junit.tests, junit.failures], [4, 1]);
  assert.deepEqual(
    junit.cases.filter((c) => c.failed).map((c) => c.name),
    ['baz@3.0.0'],
  );
  const html = parseHtml(readFileSync(join(out, 'npm_licenses.html'), 'utf8'));
  assert.equal(html.violating, 1);
  assert.match(
    readFileSync(join(out, 'npm_licenses.md'), 'utf8'),
    /\*\*baz:3\.0\.0\*\* \(Apache-2\.0\): license is on the failOn list/,
  );
});

test('API: isHtml / isJunit / isMarkdown write the files', async () => {
  const root = makeFixture();
  await run({ path: root, isHtml: true, isJunit: true, isMarkdown: true });
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.md')));
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.html')));
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.junit.xml')));
});

test('a report that cannot be written fails the run with a clear message (and the others still finish)', async () => {
  const root = makeFixture();
  const failing: Format = {
    option: 'isHtml',
    label: 'html',
    extension: 'html',
    render: () => {
      throw new Error('boom');
    },
  };
  const markdown = FORMATS.find((f) => f.label === 'markdown') as Format;
  const written = await writeReports(
    { license: { path: root, packages: {} } },
    [failing, markdown],
    meta,
  );
  const results = await Promise.allSettled(written.extras);
  assert.equal(results[0].status, 'rejected');
  assert.match(
    String((results[0] as PromiseRejectedResult).reason),
    /Unable to generate the html file due to Error: boom/,
  );
  assert.equal(results[1].status, 'fulfilled');
  assert.ok(existsSync(join(written.destinationFolder, 'npm_licenses.md')));
});

// Each package row legitimately contains its license-file path, so "no project path" is asserted for the
// header region: the page header / the text above the tables / the suite tags above the test cases.
const headerOfHtml = (html: string) => html.match(/<header>(.*?)<\/header>/s)?.[1] ?? '';
const headerOfMd = (md: string) => md.split('## Summary')[0];
const headerOfXml = (xml: string) => xml.split('<testcase ')[0];

const bracketed = reportOf(
  entry({ licenses: '(MIT OR ISC)' }),
  entry({ 'package name': 'b', licenses: 'MIT OR ISC', dependencyType: 'transitive' }),
  entry({ 'package name': 'c', licenses: 'MIT' }),
);

test('HTML: the license summary is collapsible and bracket-free; the package table keeps the raw value', () => {
  const html = renderHtmlReport(bracketed, meta);
  assert.match(html, /<details class="panel" open><summary>Licenses<\/summary><div class="dist">/);
  assert.match(html, /<\/div><\/details>/);
  // summary labels have no brackets and the two spellings are one entry (2 packages)
  const dist = html.match(/<div class="dist">(.*?)<\/div><\/details>/s)?.[1] ?? '';
  assert.deepEqual(
    [
      ...dist.matchAll(/<span>([^<]*)<\/span><span class="bar"[^>]*><\/span><span>(\d+)<\/span>/g),
    ].map((m) => [m[1], m[2]]),
    [
      ['MIT OR ISC', '2'],
      ['MIT', '1'],
    ],
  );
  assert.doesNotMatch(dist, /[()]/);
  assert.match(html, /<option value="MIT OR ISC">MIT OR ISC<\/option>/);
  assert.match(html, /data-license="MIT OR ISC" data-type="direct"/); // the filter key matches the label
  assert.match(html, /<b>2<\/b><span>distinct licenses<\/span>/);
  // the package table is untouched
  assert.equal(parseHtml(html).rows[0].licenses, '(MIT OR ISC)');
  assert.match(html, /<span>direct<\/span>/);
  assert.match(html, /<option value="direct">direct<\/option>/);
  assert.doesNotMatch(html, /immediate/);
});

test('Markdown: the license summary is a collapsible, bracket-free table', () => {
  const md = renderMarkdownReport(bracketed, meta);
  assert.match(
    md,
    /<details open>\n<summary><b>Licenses<\/b><\/summary>\n\n\| License \| Packages \|\n\| --- \| --- \|\n\| MIT OR ISC \| 2 \|\n\| MIT \| 1 \|\n\n<\/details>/,
  );
  assert.ok(
    !md.split('<details')[1].split('</details>')[0].includes('('),
    'no brackets in the summary',
  );
  assert.match(md, /- \*\*Distinct licenses:\*\* 2/);
  assert.equal(parseMarkdown(md).rows[0].licenses, '(MIT OR ISC)'); // package table keeps the raw value
  assert.doesNotMatch(md, /immediate/);
});

test('JUnit: titled for the project and without the project path', () => {
  const xml = renderJUnitReport(reportOf(entry()), meta);
  assert.match(xml, /<testsuites name="License Report for my-app" /);
  assert.match(xml, /<testsuite name="License Report for my-app" /);
  assert.ok(!xml.includes('name="path"'));
  assert.ok(!xml.includes('<properties>'));
  assert.ok(!headerOfXml(xml).includes('secret-project'), 'no project path');
  assert.match(xml, /dependencyType: direct/);
});

test('titles are escaped in every format', () => {
  const evil = { ...meta, projectName: '<b>"x"</b> & *y* | z' };
  assert.ok(!renderHtmlReport(reportOf(), evil).includes('<b>"x"'));
  assert.match(
    renderHtmlReport(reportOf(), evil),
    /<h1>License Report for &lt;b&gt;&quot;x&quot;&lt;\/b&gt; &amp; \*y\* \| z<\/h1>/,
  );
  assert.match(
    renderMarkdownReport(reportOf(), evil).split('\n')[0],
    /^# License Report for \\<b\\>"x"\\<\/b\\> \\& \\\*y\\\* \\\| z$/,
  );
  const xml = renderJUnitReport(reportOf(), evil);
  assert.ok(!xml.includes('name="License Report for <b>'));
  assert.match(
    xml,
    /<testsuites name="License Report for &lt;b&gt;&quot;x&quot;&lt;\/b&gt; &amp;amp; |<testsuites name="License Report for &lt;b&gt;&quot;x&quot;&lt;\/b&gt; &amp; /,
  );
});

test('CLI: every human-readable format is titled with the project name and has no project path', async () => {
  const root = makeFixture();
  await cli('--path', root, '--isHtml', '--isJunit', '--isMarkdown');
  const out = runDir(root);
  const html = readFileSync(join(out, 'npm_licenses.html'), 'utf8');
  const md = readFileSync(join(out, 'npm_licenses.md'), 'utf8');
  const xml = readFileSync(join(out, 'npm_licenses.junit.xml'), 'utf8');
  assert.match(html, /<h1>License Report for fx<\/h1>/);
  assert.match(md, /^# License Report for fx\n\nDate: \d{4}-\d{2}-\d{2}\n/);
  assert.match(xml, /<testsuites name="License Report for fx" /);
  for (const header of [headerOfHtml(html), headerOfMd(md), headerOfXml(xml)]) {
    assert.ok(!header.includes(root), 'the project path must not appear in the header');
  }
  // the data value is "direct" in every format
  const json = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8')).license.packages;
  assert.equal(json['foo:1.0.0'].dependencyType, 'direct');
  assert.equal(json['foo:2.0.0'].dependencyType, 'transitive');
  assert.match(xml, /dependencyType: direct/);
});

test('CLI: a project without a name is titled with its directory name', async () => {
  const root = makeFixture({ name: undefined, version: undefined });
  await cli('--path', root, '--isMarkdown');
  const dir = root.split('/').pop();
  assert.match(
    readFileSync(join(runDir(root), 'npm_licenses.md'), 'utf8'),
    new RegExp(`^# License Report for ${dir?.replace(/[-]/g, '\\\\-')}`.replace('\\\\-', '\\-')),
  );
});

const lf = (over: Partial<PackageEntry> = {}) =>
  entry({ 'license file': '/work/app/node_modules/pkg/LICENSE.md', ...over });
const cellsOf = (html: string, rowIndex = 0) =>
  [
    ...(html.match(/<tr[^>]*>(.*?)<\/tr>/gs)?.[rowIndex + 1] ?? '').matchAll(
      /<td[^>]*>(.*?)<\/td>/gs,
    ),
  ].map((m) => m[1]);

test('HTML: the license file is a link to the copied file plus a copy-path button', () => {
  const html = renderHtmlReport(reportOf(lf()), meta);
  const cell = cellsOf(html)[REPORT_FIELDS.indexOf('license file')];
  // shown by file name, not by path; the link opens the copy in licenses/ (works without JavaScript too)
  assert.match(
    cell,
    /^<a class="lic" href="licenses\/pkg%401\.0\.0" data-pkg="pkg@1\.0\.0" title="\/work\/app\/node_modules\/pkg\/LICENSE\.md">LICENSE\.md<\/a>/,
  );
  assert.equal(cell.replace(/<svg.*?<\/svg>/s, '').replace(/<[^>]+>/g, ''), 'LICENSE.md'); // no visible path
  // the button carries the COMPLETE path, a tooltip and an accessible name
  assert.match(
    cell,
    /<button type="button" class="copy" data-path="\/work\/app\/node_modules\/pkg\/LICENSE\.md" title="Copy complete path" aria-label="Copy complete path of pkg@1\.0\.0"><svg /,
  );
  // the data round-trips
  assert.equal(parseHtml(html).rows[0]['license file'], '/work/app/node_modules/pkg/LICENSE.md');
});

test('HTML: a package without a license file has no link and no copy button', () => {
  const html = renderHtmlReport(reportOf(entry({ 'license file': 'none' })), meta);
  const cell = cellsOf(html)[REPORT_FIELDS.indexOf('license file')];
  assert.equal(cell, 'none');
});

test('HTML: Windows paths show the file name and copy the whole path', () => {
  const html = renderHtmlReport(
    reportOf(lf({ 'license file': 'C:\\proj\\node_modules\\pkg\\LICENSE' })),
    meta,
  );
  const cell = cellsOf(html)[REPORT_FIELDS.indexOf('license file')];
  assert.match(cell, />LICENSE<\/a>/);
  assert.equal(parseHtml(html).rows[0]['license file'], 'C:\\proj\\node_modules\\pkg\\LICENSE');
});

test('HTML: hostile paths and names cannot break out of the link attributes', () => {
  const evil = lf({
    'package name': '@s-p"onmouseover="alert(1)',
    'license file': '/x" onclick="alert(2)" data-x="/LICENSE',
  });
  const html = renderHtmlReport(reportOf(evil), meta);
  const cell = cellsOf(html)[REPORT_FIELDS.indexOf('license file')];
  assert.doesNotMatch(cell, /\sonclick="/);
  assert.doesNotMatch(cell, /\sonmouseover="/);
  assert.equal(parseHtml(html).rows[0]['license file'], evil['license file']); // still exactly the value
});

test('HTML: a left-hand drawer with a sandboxed frame, close button and keyboard support', () => {
  const html = renderHtmlReport(reportOf(lf()), meta);
  assert.match(
    html,
    /<aside id="drawer" class="drawer" aria-hidden="true" aria-label="License file">/,
  );
  assert.match(html, /\.drawer\{[^}]*left:0[^}]*\}/); // slides in from the left
  assert.match(
    html,
    /<iframe id="d-frame" title="License file" sandbox src="about:blank"><\/iframe>/,
  );
  assert.match(html, /id="d-close"[^>]*aria-label="Close license file" title="Close \(Esc\)"/);
  assert.match(html, /id="d-copy"[^>]*title="Copy complete path"/);
  assert.match(
    html,
    /<a id="d-open" href="about:blank" target="_blank" rel="noopener noreferrer">Open in new tab<\/a>/,
  );
  assert.match(html, /e\.key==='Escape'/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.match(html, /document\.execCommand\('copy'\)/); // fallback where the clipboard API is unavailable
});

test('HTML links point exactly at the files writeReports copies (one naming function)', () => {
  const report = reportOf(
    lf({ 'package name': '@babel-code-frame', 'package version': '7.29.7' }),
    lf({ 'package name': 'foo', 'package version': '1.0.0' }),
    lf({ 'package name': 'foo', 'package version': '2.0.0' }),
  );
  const hrefs = [
    ...renderHtmlReport(report, meta).matchAll(/<a class="lic" href="licenses\/([^"]+)"/g),
  ].map((m) => decodeURIComponent(m[1]));
  assert.deepEqual(
    hrefs.sort(),
    Object.keys(planLicenseFiles(report.license.packages).files).sort(),
  );
});

test('CLI: every license link in the HTML resolves to a file in licenses/ next to it', async () => {
  const root = makeFixture();
  await cli('--path', root, '--isHtml');
  const out = runDir(root);
  const html = readFileSync(join(out, 'npm_licenses.html'), 'utf8');
  const hrefs = [...html.matchAll(/<a class="lic" href="([^"]+)"/g)].map((m) =>
    decodeURIComponent(m[1]),
  );
  assert.deepEqual(hrefs.sort(), [
    'licenses/baz@3.0.0',
    'licenses/foo@1.0.0',
    'licenses/foo@2.0.0',
  ]);
  for (const href of hrefs) assert.ok(existsSync(join(out, href)), `${href} exists`);
  // the @sc/bar package has no license file: plain "none"
  assert.equal(
    parseHtml(html).rows.find((r) => r['package name'] === '@sc-bar')?.['license file'],
    'none',
  );
});

const withManager = (pm: object | undefined) => {
  const report = reportOf(entry(), entry({ 'package name': 'b', 'package version': '2.0.0' }));
  if (pm) report.license.packageManager = pm as never;
  return report;
};
const PNPM = {
  name: 'pnpm',
  version: '9.15.9',
  source: 'node_modules/.modules.yaml',
  lockfile: 'pnpm-lock.yaml',
  lockfileVersion: '9.0',
  layout: 'pnpm-store',
};
const YARN = {
  name: 'yarn',
  family: 'berry',
  versionHint: '4.x',
  source: '.pnp.cjs',
  lockfile: 'yarn.lock',
  lockfileVersion: '8',
  layout: 'pnp',
};

test('package manager: HTML header names it, with the details in a tooltip', () => {
  const html = renderHtmlReport(withManager(PNPM), meta);
  assert.match(
    html,
    /<p class="sub">Date: 2026-01-15 &middot; Package manager: <span title="lockfile pnpm-lock\.yaml v9\.0, pnpm virtual store layout">pnpm 9\.15\.9<\/span><\/p>/,
  );
  assert.match(renderHtmlReport(withManager(YARN), meta), />Yarn 4\.x \(Berry\)<\/span>/);
  assert.match(
    renderHtmlReport(withManager(YARN), meta),
    /title="lockfile yarn\.lock v8, Plug&#39;n&#39;Play layout"/,
  );
});

test('package manager: Markdown summary line', () => {
  const md = renderMarkdownReport(withManager(PNPM), meta);
  assert.match(
    md,
    /- \*\*Package manager:\*\* pnpm 9\.15\.9; lockfile pnpm-lock\.yaml v9\.0, pnpm virtual store layout\n/,
  );
  assert.match(
    renderMarkdownReport(withManager(YARN), meta),
    /- \*\*Package manager:\*\* Yarn 4\.x \(Berry\); lockfile yarn\.lock v8, Plug'n'Play layout/,
  );
});

test('package manager: JUnit suite properties (valid placement per the JUnit schema)', () => {
  const xml = renderJUnitReport(withManager(PNPM), meta);
  assert.match(
    xml,
    /<testsuite [^>]*>\n {4}<properties>\n {6}<property name="packageManager" value="pnpm"\/>\n {6}<property name="packageManagerVersion" value="9\.15\.9"\/>\n {6}<property name="lockfile" value="pnpm-lock\.yaml"\/>\n {6}<property name="layout" value="pnpm-store"\/>\n {4}<\/properties>\n {4}<testcase /,
  );
  assert.match(
    renderJUnitReport(withManager(YARN), meta),
    /<property name="packageManagerVersion" value="4\.x"\/>/,
  );
});

test('package manager: CSV columns repeat it on every row (a flat file has no header to put it in)', () => {
  const csv = FORMATS.find((f) => f.label === 'csv')?.render(withManager(PNPM), meta) ?? '';
  const [header, ...rows] = parseCsv(csv);
  assert.deepEqual(header.slice(-3), [
    'dependencyType',
    'package manager',
    'package manager version',
  ]);
  assert.deepEqual(
    rows.map((r) => r.slice(-2)),
    [
      ['pnpm', '9.15.9'],
      ['pnpm', '9.15.9'],
    ],
  );
  const hint = parseCsv(
    FORMATS.find((f) => f.label === 'csv')?.render(withManager(YARN), meta) ?? '',
  )[1];
  assert.deepEqual(hint.slice(-2), ['yarn', '4.x']); // a hint, clearly not a full version
});

test('package manager: nothing is invented when it is unknown, and no format breaks without it', () => {
  const none = withManager(undefined);
  assert.doesNotMatch(renderHtmlReport(none, meta), /Package manager/);
  assert.doesNotMatch(renderMarkdownReport(none, meta), /Package manager/);
  assert.doesNotMatch(renderJUnitReport(none, meta), /<properties>/);
  const unknown = { name: 'unknown', source: 'no lockfile found', layout: 'node_modules' };
  assert.match(
    renderHtmlReport(withManager(unknown), meta),
    /Package manager: <span[^>]*>unknown<\/span>/,
  );
  const [, row] = parseCsv(
    FORMATS.find((f) => f.label === 'csv')?.render(withManager(unknown), meta) ?? '',
  );
  assert.deepEqual(row.slice(-2), ['unknown', '']);
  // the JSON keeps the object as is
  assert.equal(withManager(PNPM).license.packageManager?.version, '9.15.9');
});

test('package manager: hostile values from package.json are escaped in every format', () => {
  const evil = {
    name: 'pnpm',
    version: '1.0.0<script>alert(1)</script>"&',
    lockfile: 'a"b<c',
    layout: 'node_modules',
    source: 'x',
  };
  const html = renderHtmlReport(withManager(evil), meta);
  assert.ok(!html.includes('<script>alert(1)'));
  assert.match(html, /pnpm 1\.0\.0&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&amp;/);
  const xml = renderJUnitReport(withManager(evil), meta);
  assert.ok(!xml.includes('<script>'));
  assert.match(xml, /value="1\.0\.0&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&amp;"/);
  const md = renderMarkdownReport(withManager(evil), meta);
  assert.ok(
    !/(^|[^\\])<script>/.test(md.split('## Packages')[0]),
    'markdown summary has no raw tag',
  );
});

test('CLI: a real run records the package manager in all five formats', async () => {
  const root = makeFixture(); // an npm project (it has a package-lock.json)
  await cli('--path', root, '--format', 'all');
  const out = runDir(root);
  const pm = JSON.parse(readFileSync(join(out, 'npm_licenses.json'), 'utf8')).license
    .packageManager;
  assert.deepEqual(
    [pm.name, pm.versionHint, pm.lockfile, pm.layout],
    ['npm', '7 or newer', 'package-lock.json', 'node_modules'],
  );
  assert.match(
    readFileSync(join(out, 'npm_licenses.html'), 'utf8'),
    /Package manager: <span[^>]*>npm 7 or newer<\/span>/,
  );
  assert.match(
    readFileSync(join(out, 'npm_licenses.md'), 'utf8'),
    /\*\*Package manager:\*\* npm 7 or newer; lockfile package-lock\.json v3, node\\_modules layout/,
  );
  assert.match(
    readFileSync(join(out, 'npm_licenses.junit.xml'), 'utf8'),
    /<property name="packageManager" value="npm"\/>/,
  );
  assert.match(
    readFileSync(join(out, 'npm_licenses.csv'), 'utf8').split('\n')[1],
    /"npm","7 or newer"$/,
  );
});

test('CSV: cells a spreadsheet would run as a formula are neutralised, ordinary ones are untouched', () => {
  const nasty = [
    '=HYPERLINK("http://evil","x")',
    "=cmd|' /C calc'!A0",
    '+1+1',
    '-2+3',
    '@SUM(A1:A9)',
    '\tx',
    '\rx',
  ];
  for (const value of nasty)
    assert.equal(neutralizeFormula(value), `'${value}`, JSON.stringify(value));
  for (const value of [
    '@babel-code-frame',
    '@types-node',
    'plain text',
    '(MIT OR ISC)',
    '1.0.0',
    'a=b',
    'x-y',
    '',
  ]) {
    assert.equal(neutralizeFormula(value), value, value);
  }
  const csv = FORMATS.find((f) => f.label === 'csv')?.render(
    reportOf(entry({ description: '=1+1', publisher: '@evil(A1)', 'package name': '@scope-pkg' })),
    meta,
  ) as string;
  const [header, row] = parseCsv(csv);
  const cell = (name: string) => row[header.indexOf(name)];
  assert.equal(cell('description'), "'=1+1");
  assert.equal(cell('publisher'), "'@evil(A1)");
  assert.equal(cell('package name'), '@scope-pkg'); // a scoped name is not a formula
});
