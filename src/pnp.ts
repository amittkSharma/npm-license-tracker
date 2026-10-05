import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fs from 'fs-extra';
import { isExcludedPackage, type ScanGap } from './completeness';
import type { ScanDirectory } from './completion';
import { type PackageJson, readPackageJson, realPath } from './fs-utils';
import { mapLimit } from './pool';
import type { DeclaredDependency, LicenseMap, RunOptions } from './types';
import { readZipEntries, splitZipPath } from './zip-fs';

type Reference = string | [string, string] | null;
interface RegistryEntry {
  packageLocation: string;
  packageDependencies: [string, Reference][];
  linkType?: string;
}
interface PnpState {
  packageRegistryData: [string | null, [string | null, RegistryEntry][]][];
}

/** A real (non-virtual) third-party package in the Plug'n'Play registry. */
interface PnpPackage {
  key: string; // `<name>@<reference>`
  name: string;
  reference: string;
  /** Absolute location, inside a zip archive (`.zip/...`) or a real folder (unplugged) */
  dir: string;
  dependencies: Set<string>; // keys of the packages it depends on
}

type Options = Pick<RunOptions, 'production' | 'excludePrivatePackages' | 'excludePackages'>;

/** Undoes a JavaScript string literal's escapes (`\\`, `\'`, line continuations, `\n`, ...). */
const unescapeJsString = (literal: string): string =>
  literal.replace(/\\([\s\S])/g, (_, c: string) =>
    c === '\n' ? '' : c === 'n' ? '\n' : c === 't' ? '\t' : c,
  );

/**
 * Reads Yarn's Plug'n'Play data. `.pnp.cjs` embeds it as one JSON string (`RAW_RUNTIME_STATE`); it is
 * extracted and parsed, never executed (the file is code that belongs to the project being scanned).
 * With `pnpDataPath` Yarn writes plain JSON to `.pnp.data.json` instead.
 */
export function readPnpState(root: string): PnpState {
  try {
    const dataFile = join(root, '.pnp.data.json');
    if (fs.existsSync(dataFile)) return fs.readJsonSync(dataFile);
    const file = ['.pnp.cjs', '.pnp.js'].map((f) => join(root, f)).find((f) => fs.existsSync(f));
    const source = file ? fs.readFileSync(file, 'utf8') : '';
    const literal = source.match(
      /const RAW_RUNTIME_STATE =\s*'([\s\S]*?)';\s*\n\s*function \$\$SETUP_STATE/,
    )?.[1];
    if (literal === undefined) throw new Error('RAW_RUNTIME_STATE not found');
    return JSON.parse(unescapeJsString(literal));
  } catch (err) {
    throw new Error(`Cannot read Yarn Plug'n'Play data in ${root}: ${err}`);
  }
}

const baseReference = (reference: string): string =>
  reference.startsWith('virtual:') ? reference.slice(reference.indexOf('#') + 1) : reference;
const keyOf = (name: string, reference: string): string => `${name}@${baseReference(reference)}`;
const refKey = (own: string, ref: Reference): string | undefined =>
  ref === null ? undefined : typeof ref === 'string' ? keyOf(own, ref) : keyOf(ref[0], ref[1]);

/**
 * The packages Yarn installed. "Virtual" instances (a package re-resolved for its peer dependencies)
 * point back to one real package and are folded into it; workspaces and `link:`/`portal:` packages
 * are the project's own code, not dependencies, and are left out.
 */
export function listPnpPackages(
  state: PnpState,
  root: string,
): {
  packages: Map<string, PnpPackage>;
  rootDependencies: Map<string, string>;
  /** Virtual instances whose real package is not in the registry: they cannot be read */
  orphans: string[];
  /** Workspace members of a monorepo: their own folder and what each dependency name resolves to */
  workspaces: { dir: string; edges: Map<string, string> }[];
} {
  const packages = new Map<string, PnpPackage>();
  const extraEdges = new Map<string, Set<string>>();
  const rootDependencies = new Map<string, string>(); // dependency name -> package key
  const workspaces: { dir: string; edges: Map<string, string> }[] = [];
  for (const [name, instances] of state.packageRegistryData) {
    for (const [reference, entry] of instances) {
      const edges = entry.packageDependencies
        .map(([depName, ref]) => [depName, refKey(depName, ref)] as const)
        .filter((e): e is readonly [string, string] => e[1] !== undefined);
      if (name === null || reference === null) {
        for (const [depName, key] of edges) rootDependencies.set(depName, key);
        continue;
      }
      // the project's own code is not a dependency (a `SOFT` base entry of a virtualised package IS real)
      if (/^(workspace|link|portal):/.test(reference)) {
        if (reference.startsWith('workspace:')) {
          workspaces.push({ dir: resolve(root, entry.packageLocation), edges: new Map(edges) });
        }
        continue;
      }
      const key = keyOf(name, reference);
      if (reference.startsWith('virtual:')) {
        const merged = extraEdges.get(key) ?? new Set<string>();
        for (const [, k] of edges) merged.add(k);
        extraEdges.set(key, merged);
        continue;
      }
      packages.set(key, {
        key,
        name,
        reference,
        dir: resolve(root, entry.packageLocation).replace(/[\\/]+$/, ''),
        dependencies: new Set(edges.map(([, k]) => k)),
      });
    }
  }
  const orphans: string[] = [];
  for (const [key, extra] of extraEdges) {
    const real = packages.get(key);
    if (!real) orphans.push(key);
    else for (const k of extra) real.dependencies.add(k);
  }
  return { packages, rootDependencies, orphans, workspaces };
}

/** Everything reachable from `starts` through dependencies. */
function reachable(packages: Map<string, PnpPackage>, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const key = queue.pop() as string;
    if (seen.has(key) || !packages.has(key)) continue;
    seen.add(key);
    queue.push(...(packages.get(key)?.dependencies ?? []));
  }
  return seen;
}

/**
 * Scans a Yarn Plug'n'Play project. The registry in `.pnp.cjs` lists every package; each one lives in a
 * zip archive (or an "unplugged" folder). A package's top-level files (package.json, LICENSE, ...) are
 * extracted to a temporary folder so the same scanner that reads node_modules reads them, and the paths
 * in the result are rewritten to Yarn's `archive.zip/node_modules/<name>/...` notation, so a report
 * never points at the temporary folder. Nothing is left behind; the project is never modified.
 */
export async function scanPnp(
  root: string,
  declared: DeclaredDependency[],
  options: Options,
  scanDirectory: ScanDirectory,
): Promise<{ result: LicenseMap; gaps: ScanGap[] }> {
  const { packages, rootDependencies, orphans, workspaces } = listPnpPackages(
    readPnpState(root),
    root,
  );
  const direct = new Set(
    declared.map((d) => rootDependencies.get(d.name)).filter((k): k is string => !!k),
  );
  // production: start from what the project and every workspace member need to run (not their devDependencies)
  const memberStarts = workspaces.flatMap(({ dir, edges }) => {
    const manifest = readPackageJson(dir);
    const lists = [
      manifest?.dependencies,
      manifest?.optionalDependencies,
      manifest?.peerDependencies,
    ];
    return lists.flatMap((list) => Object.keys(list ?? {})).map((name) => edges.get(name));
  });
  const starts = (
    options.production
      ? [
          ...declared
            .filter((d) => d.type !== 'devDependency')
            .map((d) => rootDependencies.get(d.name)),
          ...memberStarts,
        ]
      : [...packages.keys()]
  ).filter((k): k is string => !!k);
  const included = [...reachable(packages, starts)].map((key) => packages.get(key) as PnpPackage);

  const result: LicenseMap = {};
  const gaps: ScanGap[] = orphans.map((what) => ({
    kind: 'not-scanned',
    what,
    requiredBy: '.pnp.cjs',
  }));
  // Yarn lists optional dependencies built for other platforms (esbuild's `linux-arm`, parcel's
  // `win32-x64`, ...) but never unpacks them. Absent files are fine for a package that some installed
  // package declares as an `optionalDependency`; for any other package they mean an unfinished install.
  const absent: PnpPackage[] = [];
  const optionalNames = new Set(Object.keys(readPackageJson(root)?.optionalDependencies ?? {}));
  const work = await fs.mkdtemp(join(tmpdir(), 'nlt-pnp-'));
  try {
    await mapLimit(
      included.map((pkg, index) => ({ pkg, index })),
      8,
      async ({ pkg, index }) => {
        const zip = splitZipPath(pkg.dir);
        let scanDir = pkg.dir;
        let toVirtual = (p: string) => p;
        if (!fs.existsSync(zip ? zip.zip : pkg.dir)) {
          absent.push(pkg); // judged once every package's own manifest is known (see below)
          return;
        }
        if (zip) {
          const prefix = `${zip.inner.replace(/\/+$/, '')}/`;
          const files = readZipEntries(
            zip.zip,
            (name) =>
              name.startsWith(prefix) &&
              name.length > prefix.length &&
              !name.slice(prefix.length).includes('/'),
          );
          scanDir = join(work, String(index));
          await fs.ensureDir(scanDir);
          for (const [name, data] of Object.entries(files)) {
            await fs.writeFile(join(scanDir, name.slice(prefix.length)), data);
          }
          const real = realPath(scanDir);
          toVirtual = (p) =>
            realPath(p).startsWith(real)
              ? `${zip.zip}/${prefix}${realPath(p)
                  .slice(real.length + 1)
                  .replace(/\\/g, '/')}`.replace(/\/$/, '')
              : p;
        }
        const own = realPath(scanDir);
        const found = Object.entries(await scanDirectory(scanDir)).filter(
          ([, info]) => info.path && realPath(info.path) === own,
        );
        const meta: PackageJson | undefined = readPackageJson(scanDir);
        for (const name of Object.keys(meta?.optionalDependencies ?? {})) optionalNames.add(name);
        if (!found.length) {
          if (!(meta && isExcludedPackage(meta, options))) {
            gaps.push({ kind: 'not-scanned', what: pkg.key, requiredBy: '.pnp.cjs' });
          }
          return;
        }
        for (const [key, info] of found) {
          result[key] = {
            ...info,
            path: toVirtual(info.path as string),
            licenseFile:
              info.licenseFile && info.licenseFile !== 'none'
                ? toVirtual(info.licenseFile)
                : info.licenseFile,
            direct: direct.has(pkg.key) || result[key]?.direct === true,
          };
        }
      },
    );
  } finally {
    await fs.remove(work);
  }
  for (const pkg of absent) {
    if (!optionalNames.has(pkg.name)) {
      gaps.push({ kind: 'not-installed', what: pkg.key, requiredBy: '.pnp.cjs' });
    }
  }
  return { result, gaps };
}
