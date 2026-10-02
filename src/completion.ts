import { findScanGaps } from './completeness';
import { mapLimit } from './pool';
import type { DeclaredDependency, LicenseMap, RunOptions } from './types';

/** Scans the one package folder `dir` with the scanner. */
export type ScanDirectory = (dir: string) => Promise<LicenseMap>;

type Options = Pick<RunOptions, 'production' | 'excludePrivatePackages' | 'excludePackages'>;

/**
 * Completes a scan the scanner only partly managed. It finds packages that are installed (a scanned
 * package depends on them) but missing from the result, scans each of those folders on its own, and
 * repeats until the dependency tree is covered. This is how pnpm's symlinked layout is read: the
 * scanner sees the packages linked in `node_modules`, and their dependencies are siblings inside the
 * `.pnpm` store that it does not follow. A flat install has no gaps, so nothing extra is scanned.
 */
export async function completeScan(
  root: string,
  declared: DeclaredDependency[],
  scanned: LicenseMap,
  options: Options,
  scanDirectory: ScanDirectory,
): Promise<LicenseMap> {
  const result: LicenseMap = { ...scanned };
  const tried = new Set<string>();
  for (;;) {
    const dirs = [
      ...new Set(
        findScanGaps(root, declared, result, options)
          .filter((gap) => gap.kind === 'not-scanned' && gap.dir && !tried.has(gap.dir))
          .map((gap) => gap.dir as string),
      ),
    ];
    if (!dirs.length) return result;
    for (const dir of dirs) tried.add(dir); // a folder that yields nothing is not retried forever
    for (const found of await mapLimit(dirs, 8, scanDirectory)) Object.assign(result, found);
  }
}
