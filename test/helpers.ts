import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const write = (file: string, data: unknown) =>
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));

/** Builds a tiny project: foo + @sc/bar are declared deps, baz is a devDep, and baz nests foo@2.0.0. */
export function makeFixture(rootPkg: object = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'nlt-'));
  const mod = (name: string, pkg: object, license?: string) => {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'package.json'), { name: name.split('node_modules/').pop(), ...pkg });
    if (license) write(join(dir, 'LICENSE'), license);
  };
  write(join(root, 'package.json'), {
    name: 'fx',
    version: '1.0.0',
    dependencies: { foo: '^1.0.0', '@sc/bar': '2.0.0' },
    devDependencies: { baz: '3.0.0' },
    ...rootPkg,
  });
  mod(
    'foo',
    {
      version: '1.0.0',
      description: 'foo, pkg',
      license: 'MIT',
      repository: 'git+https://github.com/acme/foo.git',
      author: { name: 'Ann', email: 'ann@x.io' },
    },
    'MIT foo',
  );
  write(join(root, 'package-lock.json'), {
    name: 'fx',
    lockfileVersion: 3,
    requires: true,
    packages: {},
  });
  mod('@sc/bar', { version: '2.0.0', license: 'ISC', repository: 'https://github.com/acme/bar' });
  mod('baz', { version: '3.0.0', license: 'Apache-2.0' }, 'Apache baz');
  // second version of foo, nested: same name as the top-level foo, different license text
  mod(
    'baz/node_modules/foo',
    { version: '2.0.0', licenses: [{ type: 'MIT' }, { type: 'ISC' }] },
    'MIT foo two',
  );
  return root;
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes), enough for json2csv output. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Merges `patch` into node_modules/<dir>/package.json of a fixture. */
export function patchPackage(root: string, dir: string, patch: object): void {
  const file = join(root, 'node_modules', dir, 'package.json');
  write(file, { ...JSON.parse(readFileSync(file, 'utf8')), ...patch });
}

export function writeJson(file: string, data: unknown): string {
  write(file, data);
  return file;
}

const decode = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&#9;/g, '\t')
    .replace(/&amp;/g, '&');

/** Reads the package table of the HTML report back into { field: value } rows (in table order). */
export function parseHtml(html: string): {
  header: string[];
  rows: Record<string, string>[];
  violating: number;
} {
  const header = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => decode(m[1]));
  const trs = [
    ...html.matchAll(/<tr( class="viol")? data-license="[^"]*" data-type="[^"]*">(.*?)<\/tr>/gs),
  ];
  const rows = trs.map((tr) => {
    // the license file is shown by name; its complete path is on the copy button
    const cells = [...tr[2].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => {
      const copyPath = c[1].match(/class="copy" data-path="([^"]*)"/)?.[1];
      return decode(copyPath ?? c[1].replace(/<[^>]+>/g, ''));
    });
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, rows, violating: trs.filter((t) => t[1]).length };
}

/** Reads a JUnit report back into test cases with their listed fields (in listed order). */
export function parseJUnit(xml: string) {
  const suite = xml.match(
    /<testsuite name="([^"]*)" tests="(\d+)" failures="(\d+)" errors="(\d+)"/,
  );
  const cases = [
    ...xml.matchAll(/<testcase classname="([^"]*)" name="([^"]*)" time="0">(.*?)<\/testcase>/gs),
  ].map((m) => {
    const out = m[3].match(/<system-out>(.*?)<\/system-out>/s)?.[1] ?? '';
    const fields: [string, string][] = decode(out)
      .split('\n')
      .map((line) => {
        const i = line.indexOf(': ');
        return [line.slice(0, i), line.slice(i + 2)];
      });
    return {
      classname: decode(m[1]),
      name: decode(m[2]),
      failed: m[3].includes('<failure'),
      fields,
    };
  });
  return {
    tests: Number(suite?.[2]),
    failures: Number(suite?.[3]),
    errors: Number(suite?.[4]),
    cases,
  };
}

/** Reads the package table of the Markdown report back into { field: value } rows. */
export function parseMarkdown(md: string): { header: string[]; rows: Record<string, string>[] } {
  const section = md.split('\n## Packages\n')[1] ?? '';
  const lines = section.split('\n').filter((l) => l.startsWith('|'));
  // cells are separated by " | "; a pipe inside a value is written "\\|", so it never matches
  const split = (line: string) => line.slice(2, -2).split(/\s\|\s/);
  const unescapeMd = (c: string) => c.replace(/\\([\\`*_[\]<>|&~])/g, '$1');
  const text = (c: string) => {
    const link = c.match(/^<(https?:[^>]*)>$/);
    return link ? link[1].replace(/\\\|/g, '|') : unescapeMd(c);
  };
  const header = split(lines[0]);
  const rows = lines
    .slice(2)
    .map((l) => Object.fromEntries(split(l).map((c, i) => [header[i], text(c)])));
  return { header, rows };
}

/** The newest per-run folder a fixture project got under npm_licenses/ (names sort by time). */
export function runDir(root: string): string {
  const parent = join(root, 'npm_licenses');
  const runs = readdirSync(parent).sort();
  return join(parent, runs[runs.length - 1]);
}

/**
 * Builds an arbitrary project on disk: `files` maps relative paths to JSON content, `links` maps a
 * relative symlink path to the relative path it points at (how pnpm lays out node_modules).
 */
export function makeTree(
  files: Record<string, object>,
  links: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'nlt-tree-'));
  for (const [rel, json] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    write(join(root, rel), json);
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, link)), { recursive: true });
    symlinkSync(join(root, target), join(root, link));
  }
  return root;
}

const pkgJson = (name: string, extra: object = {}) => ({
  name,
  version: '1.0.0',
  license: 'MIT',
  ...extra,
});

/** A pnpm-style install of `app` -> `a` -> `b`: real packages in node_modules/.pnpm, symlinks everywhere else. */
export function makePnpmLikeProject(): string {
  const store = (id: string, name: string) => `node_modules/.pnpm/${id}/node_modules/${name}`;
  return makeTree(
    {
      'package.json': { name: 'pnpm-app', version: '1.0.0', dependencies: { a: '1.0.0' } },
      [`${store('a@1.0.0', 'a')}/package.json`]: pkgJson('a', { dependencies: { b: '1.0.0' } }),
      [`${store('b@1.0.0', 'b')}/package.json`]: pkgJson('b'),
    },
    {
      'node_modules/a': store('a@1.0.0', 'a'),
      // b is a sibling of a inside a's virtual-store folder, as pnpm lays it out
      'node_modules/.pnpm/a@1.0.0/node_modules/b': store('b@1.0.0', 'b'),
    },
  );
}

// ---------------------------------------------------------------------------------------------------
// Realistic pnpm and Yarn Plug'n'Play projects, built offline from a small package description.

export interface FakePackage {
  name: string;
  version?: string;
  license?: string;
  /** names of other FakePackages this one depends on */
  deps?: string[];
  /** dependencies that are also `optionalDependencies`; they need not exist in the project's package list */
  optionalDeps?: string[];
  private?: boolean;
  /** Plug'n'Play: keep the package in a real folder under .yarn/unplugged instead of a zip */
  unplugged?: boolean;
  /** Plug'n'Play: listed in the registry but never unpacked (a platform binary for another OS) */
  absent?: boolean;
}

interface FakeProject {
  /** names of the packages the project declares in `dependencies` */
  prod: string[];
  /** ... in `devDependencies` */
  dev?: string[];
  packages: FakePackage[];
  name?: string;
  /** Yarn workspace members (monorepo): their own dependencies */
  workspaces?: { name: string; deps?: string[]; devDeps?: string[] }[];
}

const slug = (name: string): string => name.replace('/', '-');
const versionOf = (p: FakePackage): string => p.version ?? '1.0.0';
const manifest = (p: FakePackage, all: FakePackage[]): object => ({
  name: p.name,
  version: versionOf(p),
  license: p.license ?? 'MIT',
  ...(p.private && { private: true }),
  description: `${p.name} package`,
  dependencies: Object.fromEntries(
    (p.deps ?? []).map((d) => [d, all.find((x) => x.name === d)?.version ?? '1.0.0']),
  ),
  ...(p.optionalDeps && {
    optionalDependencies: Object.fromEntries(p.optionalDeps.map((d) => [d, '1.0.0'])),
  }),
});
const licenseText = (p: FakePackage): string => `License text of ${p.name}@${versionOf(p)}\n`;
const rootManifest = (project: FakeProject, all: FakePackage[]) => ({
  name: project.name ?? 'fake-app',
  version: '1.0.0',
  dependencies: Object.fromEntries(
    project.prod.map((n) => [n, versionOf(all.find((x) => x.name === n) as FakePackage)]),
  ),
  devDependencies: Object.fromEntries(
    (project.dev ?? []).map((n) => [n, versionOf(all.find((x) => x.name === n) as FakePackage)]),
  ),
});

/** pnpm 9, default layout: packages live in node_modules/.pnpm/<id>/node_modules/<name>, linked by symlinks. */
export function makePnpmProject(project: FakeProject): string {
  const all = project.packages;
  const store = (p: FakePackage) =>
    `node_modules/.pnpm/${p.name.replace('/', '+')}@${versionOf(p)}/node_modules/${p.name}`;
  const files: Record<string, object> = { 'package.json': rootManifest(project, all) };
  for (const p of all) {
    files[`${store(p)}/package.json`] = manifest(p, all);
  }
  const root = makeTree(files);
  for (const p of all) {
    writeFileSync(join(root, store(p), 'LICENSE'), licenseText(p));
    const siblings = join(root, store(p).slice(0, store(p).length - p.name.length - 1));
    // an optional dependency is linked only when it exists in the project (the binary for this platform)
    for (const d of [
      ...(p.deps ?? []),
      ...(p.optionalDeps ?? []).filter((o) => all.some((x) => x.name === o)),
    ]) {
      const target = all.find((x) => x.name === d) as FakePackage;
      mkdirSync(dirname(join(siblings, d)), { recursive: true });
      symlinkSync(join(root, store(target)), join(siblings, d));
    }
  }
  for (const n of [...project.prod, ...(project.dev ?? [])]) {
    const target = all.find((x) => x.name === n) as FakePackage;
    mkdirSync(dirname(join(root, 'node_modules', n)), { recursive: true });
    symlinkSync(join(root, store(target)), join(root, 'node_modules', n));
  }
  write(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  write(
    join(root, 'node_modules', '.modules.yaml'),
    'layoutVersion: 5\nnodeLinker: isolated\npackageManager: pnpm@9.15.9\n',
  );
  return root;
}

export interface PnpOptions {
  /** packages that get a "virtual" peer-resolved instance (their real entry becomes a SOFT base) */
  virtual?: string[];
  /** dependencies that exist only on a package's virtual instance (peer dependencies Yarn resolved) */
  virtualOnlyDeps?: Record<string, string[]>;
  /** a virtual instance whose real package is absent from the registry */
  orphanVirtual?: string[];
  /** zip archives left out of the cache (an unfinished `yarn install`) */
  missingZip?: string[];
  /** write `.pnp.data.json` (pnpDataPath) instead of embedding the state in `.pnp.cjs` */
  dataFile?: boolean;
  /** workspaces / link: / portal: entries, which are the project's own code */
  extraLocal?: string[];
}

/** Yarn 4 Plug'n'Play: packages in zip archives (or .yarn/unplugged), listed in .pnp.cjs. */
export function makePnpProject(project: FakeProject, options: PnpOptions = {}): string {
  const all = project.packages;
  const root = makeTree({ 'package.json': rootManifest(project, all) });
  const ref = (p: FakePackage) => `npm:${versionOf(p)}`;
  const virtualRef = (p: FakePackage) => `virtual:${'ab12'.repeat(8)}#${ref(p)}`;
  const depRef = (name: string) => {
    const target = all.find((x) => x.name === name) as FakePackage;
    return (options.virtual ?? []).includes(name) ? virtualRef(target) : ref(target);
  };
  const registry: [string | null, [string | null, object][]][] = [
    [
      null,
      [
        [
          null,
          {
            packageLocation: './',
            packageDependencies: [...project.prod, ...(project.dev ?? [])].map((n) => [
              n,
              depRef(n),
            ]),
            linkType: 'SOFT',
          },
        ],
      ],
    ],
  ];
  for (const p of all) {
    const archive = `${slug(p.name)}-npm-${versionOf(p)}-0123456789-10c0.zip`;
    const inner = `node_modules/${p.name}`;
    let location: string;
    if (p.absent) {
      location = `./.yarn/unplugged/${slug(p.name)}-npm-${versionOf(p)}-0123456789/${inner}/`; // not created
    } else if (p.unplugged) {
      const dir = `.yarn/unplugged/${slug(p.name)}-npm-${versionOf(p)}-0123456789/${inner}`;
      mkdirSync(join(root, dir), { recursive: true });
      write(join(root, dir, 'package.json'), manifest(p, all));
      writeFileSync(join(root, dir, 'LICENSE'), licenseText(p));
      location = `./${dir}/`;
    } else {
      if (!(options.missingZip ?? []).includes(p.name)) {
        mkdirSync(join(root, '.yarn/cache'), { recursive: true });
        writeFileSync(
          join(root, '.yarn/cache', archive),
          zipSync({
            [`${inner}/package.json`]: strToU8(JSON.stringify(manifest(p, all))),
            [`${inner}/LICENSE`]: strToU8(licenseText(p)),
            [`${inner}/lib/index.js`]: strToU8('module.exports = 1;'), // deeper files must not be extracted
            [`${inner}/lib/LICENSE`]: strToU8('NOT the package license'),
          }),
        );
      }
      location = `./.yarn/cache/${archive}/${inner}/`;
    }
    const deps = [
      ...(p.deps ?? []),
      ...(p.optionalDeps ?? []).filter((o) => all.some((x) => x.name === o)),
    ].map((d) => [d, depRef(d)]);
    const virtual = (options.virtual ?? []).includes(p.name);
    registry.push([
      p.name,
      [
        [
          ref(p),
          {
            packageLocation: location,
            packageDependencies: deps,
            linkType: virtual ? 'SOFT' : 'HARD',
          },
        ],
        ...(virtual
          ? [
              [
                virtualRef(p),
                {
                  packageLocation: `./.yarn/__virtual__/${slug(p.name)}-virtual-0123/0/${location.slice(2)}`,
                  // peer dependencies are resolved per virtual instance, so only it knows about them
                  packageDependencies: [
                    ...deps,
                    ...(options.virtualOnlyDeps?.[p.name] ?? []).map((d) => [d, depRef(d)]),
                  ],
                  linkType: 'HARD',
                },
              ] as [string, object],
            ]
          : []),
      ],
    ]);
  }
  for (const w of project.workspaces ?? []) {
    const names = [...(w.deps ?? []), ...(w.devDeps ?? [])];
    mkdirSync(join(root, 'packages', w.name), { recursive: true });
    write(join(root, 'packages', w.name, 'package.json'), {
      name: `@ws/${w.name}`,
      version: '1.0.0',
      dependencies: Object.fromEntries((w.deps ?? []).map((d) => [d, '1.0.0'])),
      devDependencies: Object.fromEntries((w.devDeps ?? []).map((d) => [d, '1.0.0'])),
    });
    registry.push([
      `@ws/${w.name}`,
      [
        [
          `workspace:packages/${w.name}`,
          {
            packageLocation: `./packages/${w.name}/`,
            packageDependencies: names.map((d) => [d, depRef(d)]),
            linkType: 'SOFT',
          },
        ],
      ],
    ]);
  }
  for (const name of options.orphanVirtual ?? []) {
    registry.push([
      name,
      [
        [
          `virtual:${'cd34'.repeat(8)}#npm:9.9.9`,
          {
            packageLocation: './.yarn/__virtual__/x/0/nowhere/',
            packageDependencies: [],
            linkType: 'HARD',
          },
        ],
      ],
    ]);
  }
  for (const local of options.extraLocal ?? []) {
    registry.push([
      `@local/${local}`,
      [
        [
          `workspace:packages/${local}`,
          { packageLocation: `./packages/${local}/`, packageDependencies: [], linkType: 'SOFT' },
        ],
      ],
    ]);
  }
  const state = {
    __info: ['generated by tests'],
    dependencyTreeRoots: [{ name: project.name ?? 'fake-app', reference: 'workspace:.' }],
    packageRegistryData: registry,
  };
  if (options.dataFile) {
    write(join(root, '.pnp.data.json'), state);
    writeFileSync(join(root, '.pnp.cjs'), '// state is in .pnp.data.json\n');
  } else {
    // escape the JSON exactly as Yarn does: it becomes the body of a single-quoted JavaScript string
    const literal = JSON.stringify(state, null, 2)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\\n');
    writeFileSync(
      join(root, '.pnp.cjs'),
      `#!/usr/bin/env node\n"use strict";\n\nconst RAW_RUNTIME_STATE =\n'${literal}';\n\nfunction $$SETUP_STATE(hydrateRuntimeState, basePath) {\n}\n`,
    );
  }
  writeFileSync(join(root, 'yarn.lock'), '__metadata:\n  version: 8\n  cacheKey: 10c0\n');
  return root;
}
