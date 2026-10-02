import { type PackageJson, readPackageJson, realPath, resolveInstalled } from './fs-utils';
import type { DeclaredDependency, LicenseMap, RunOptions } from './types';

export interface ScanGap {
  /** `not-installed`: nowhere on disk. `not-scanned`: on disk, but missing from the scan result. */
  kind: 'not-installed' | 'not-scanned';
  /** `name` or `name@version` */
  what: string;
  /** `package.json` or `name@version` of the package that needs it */
  requiredBy: string;
  /** For `not-scanned`: the real folder the package is installed in (symlinks resolved) */
  dir?: string;
}

export class IncompleteScanError extends Error {
  readonly gaps: ScanGap[];

  constructor(gaps: ScanGap[]) {
    const section = (kind: ScanGap['kind'], title: string) => {
      const items = gaps.filter((g) => g.kind === kind);
      if (!items.length) return [];
      const shown = items.slice(0, 10).map((g) => `    - ${g.what} (required by ${g.requiredBy})`);
      const more =
        items.length > shown.length ? [`    ... and ${items.length - shown.length} more`] : [];
      return [`  ${title}:`, ...shown, ...more];
    };
    super(
      [
        'The scan is incomplete, so a report would hide dependencies. Nothing was written.',
        ...section('not-installed', 'Not installed'),
        ...section('not-scanned', 'Installed, but the scanner did not read them'),
        'Install the dependencies first (for example `npm ci`). If they are installed, they use a layout',
        'the scanner cannot read. To write the report anyway, use --allowIncomplete.',
      ].join('\n'),
    );
    this.name = 'IncompleteScanError';
    this.gaps = gaps;
  }
}

type Options = Pick<RunOptions, 'production' | 'excludePrivatePackages' | 'excludePackages'>;

/** Whether the user's exclusion options leave this package out (the scanner's own prefix rule). */
export const isExcludedPackage = (pkg: PackageJson, options: Options): boolean =>
  (!!options.excludePrivatePackages && !!pkg.private) ||
  toArray(options.excludePackages).some((pattern) =>
    matchesExclusion(`${pkg.name}@${pkg.version}`, pattern),
  );

const toArray = (value: string[] | undefined): string[] => value ?? [];

/** The scanner's own rule: `name`, `name@major` or `name@version`, matched as a prefix of `name@version`. */
const matchesExclusion = (key: string, pattern: string): boolean =>
  key.startsWith(pattern.lastIndexOf('@') > 0 ? pattern : `${pattern}@`);

/**
 * Checks that the scan really covers the dependency tree. Every required dependency of the project and
 * of each scanned package must be installed *and* be in the scan result. Without this, an uninstalled
 * project or an unreadable layout (pnpm) produces a confident but empty or partial report.
 * Packages the user excluded on purpose (private, `excludePackages`) are not gaps.
 */
export function findScanGaps(
  root: string,
  declared: DeclaredDependency[],
  scanned: LicenseMap,
  options: Options & { excludePackages?: string[] } = {},
): ScanGap[] {
  // the scanner keys its result by `name@version`: copies of one version installed in several places
  // (nested node_modules) are a single entry, so identity, not location, says whether a package was read
  const scannedKeys = new Set(Object.keys(scanned));
  const isExcluded = (pkg: PackageJson): boolean => isExcludedPackage(pkg, options);

  const gaps = new Map<string, ScanGap>();
  /** Packages to look beneath: everything scanned, plus excluded ones (their dependencies still count) */
  const queue: { dir: string; label: string }[] = [];
  const visited = new Set<string>();
  const enqueue = (dir: string, label: string) => {
    const real = realPath(dir);
    if (visited.has(real)) return;
    visited.add(real);
    queue.push({ dir: real, label });
  };

  const check = (found: ReturnType<typeof resolveInstalled>, name: string, requiredBy: string) => {
    if (!found) {
      // the first reason found is kept (the project's own package.json is checked first)
      const key = `not-installed:${name}`;
      if (!gaps.has(key)) gaps.set(key, { kind: 'not-installed', what: name, requiredBy });
      return;
    }
    const what = `${found.pkg.name}@${found.pkg.version}`;
    if (scannedKeys.has(what)) return;
    if (isExcluded(found.pkg)) {
      // left out on purpose, but whatever it needs is still installed and still belongs in the report
      enqueue(found.dir, what);
      return;
    }
    const key = `not-scanned:${what}`;
    if (!gaps.has(key)) {
      gaps.set(key, { kind: 'not-scanned', what, requiredBy, dir: realPath(found.dir) });
    }
  };

  // what the project declares (devDependencies too, unless they were left out on purpose)
  for (const d of declared) {
    if (options.production && d.type === 'devDependency') continue;
    const found = resolveInstalled(root, d.name);
    // an optional or peer dependency may be absent (another platform's binary, a peer nobody installed)
    if (!found && (d.type === 'optionalDependency' || d.type === 'peerDependency')) continue;
    check(found, d.name, 'package.json');
  }
  for (const info of Object.values(scanned)) {
    if (info.path) enqueue(info.path, `${info.name}@${info.version}`);
  }
  // what every one of those packages needs to run (optional dependencies may legitimately be absent)
  for (let i = 0; i < queue.length; i++) {
    const { dir, label } = queue[i];
    const pkg = readPackageJson(dir);
    // Packages such as esbuild list their platform binaries ONLY under `optionalDependencies`, so both
    // lists are read. An optional dependency may be absent (the binary for another platform), but when it
    // IS installed (the one for this platform) it belongs in the report like any other package.
    const optional = pkg?.optionalDependencies ?? {};
    for (const name of new Set([
      ...Object.keys(pkg?.dependencies ?? {}),
      ...Object.keys(optional),
    ])) {
      const found = resolveInstalled(dir, name);
      if (!found && name in optional) continue;
      check(found, name, label);
    }
  }
  return [...gaps.values()];
}
