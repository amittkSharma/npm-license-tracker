import { dirname, join, resolve, sep } from 'node:path';
import fs from 'fs-extra';

/** Real path (symlinks resolved), or the absolute input when it does not exist. */
export const realPath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Whether node_modules is pnpm's default layout: top-level packages are symlinks into the `.pnpm`
 * virtual store. (pnpm's `hoisted` linker also has a `.pnpm` folder, but its top-level packages are real
 * folders; ordinary symlinks such as workspace members or `npm link` do not point into `.pnpm`.)
 */
export function usesPnpmStore(root: string): boolean {
  const modules = join(root, 'node_modules');
  const linksIntoStore = (entry: string) =>
    fs.lstatSync(entry).isSymbolicLink() && realPath(entry).includes(`${sep}.pnpm${sep}`);
  try {
    return fs
      .readdirSync(modules)
      .filter((name) => !name.startsWith('.'))
      .slice(0, 50)
      .some((name) => {
        const entry = join(modules, name);
        // scoped packages are symlinks inside a real `@scope` folder
        return name.startsWith('@')
          ? fs
              .readdirSync(entry)
              .slice(0, 50)
              .some((inner) => linksIntoStore(join(entry, inner)))
          : linksIntoStore(entry);
      });
  } catch {
    return false; // no node_modules
  }
}

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  /** Corepack's `<manager>@<version>` */
  packageManager?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The package.json inside `dir`, or undefined when there is none (or it is unreadable). */
export const readPackageJson = (dir: string): PackageJson | undefined =>
  fs.readJsonSync(join(dir, 'package.json'), { throws: false }) ?? undefined;

/**
 * Finds `name` the way Node resolves it from `fromDir`: `<dir>/node_modules/<name>` for `fromDir` and
 * each parent. Works for flat npm trees and for symlinked layouts such as pnpm's.
 */
export function resolveInstalled(
  fromDir: string,
  name: string,
): { dir: string; pkg: PackageJson } | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    const pkg = readPackageJson(candidate);
    if (pkg) return { dir: candidate, pkg };
    if (dirname(dir) === dir) return undefined;
  }
}
