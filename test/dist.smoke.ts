// Smoke test for the BUILT package (run `npm run build` first; `npm run test:dist` does both checks
// publishing relies on). Unlike the other tests it exercises dist/ through package.json, as a
// consumer would: the exports map, main/types/bin targets, and the compiled CLI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { makeFixture, runDir } from './helpers';

const exec = promisify(execFile);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('main, types and bin point at files that exist', () => {
  for (const file of [pkg.main, pkg.types, pkg.bin['npm-tracker']]) {
    assert.ok(existsSync(file), `${file} is missing - run "npm run build"`);
  }
  assert.match(readFileSync(pkg.bin['npm-tracker'], 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('every exports entry resolves and exposes run()', () => {
  for (const entry of ['', '/src', '/src/index', '/src/index.js']) {
    // self-reference through the package's own exports map, like `require('npm-license-tracker/src')`
    const mod = require(`${pkg.name}${entry}`);
    assert.equal(typeof mod.run, 'function', `${pkg.name}${entry}`);
  }
});

test('compiled CLI produces the report', async () => {
  const root = makeFixture();
  const { stdout } = await exec(process.execPath, [pkg.bin['npm-tracker'], '--path', root]);
  assert.match(stdout, /JSON file is created/);
  assert.ok(existsSync(join(runDir(root), 'npm_licenses.json')));
});

test('compiled CLI writes the HTML and JUnit reports', async () => {
  const root = makeFixture();
  await exec(process.execPath, [
    pkg.bin['npm-tracker'],
    '--path',
    root,
    '--isHtml',
    '--isJunit',
    '--isMarkdown',
  ]);
  for (const file of ['npm_licenses.html', 'npm_licenses.junit.xml', 'npm_licenses.md']) {
    assert.ok(existsSync(join(runDir(root), file)), file);
  }
  assert.match(readFileSync(join(runDir(root), 'npm_licenses.html'), 'utf8'), /<!DOCTYPE html>/);
  assert.match(readFileSync(join(runDir(root), 'npm_licenses.junit.xml'), 'utf8'), /<testsuites /);
});

test('compiled CLI exits 1 on failure', async () => {
  await assert.rejects(
    exec(process.execPath, [pkg.bin['npm-tracker'], '--path', join(makeFixture(), 'missing')]),
    (err: { code: number }) => err.code === 1,
  );
});
