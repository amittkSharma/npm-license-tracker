import { join } from 'node:path';
import fs from 'fs-extra';
import { readPackageJson, usesPnpmStore } from './fs-utils';

export interface PackageManagerInfo {
  name: 'npm' | 'yarn' | 'pnpm' | 'unknown';
  /** Exact version, only when the project or the install records it (never guessed) */
  version?: string;
  /** What is known without an exact version, e.g. `4.x` from a Yarn lockfile format */
  versionHint?: string;
  /** Yarn only: `classic` (1.x) or `berry` (2+) */
  family?: 'classic' | 'berry';
  /** Where the identity or version came from, e.g. `node_modules/.modules.yaml` */
  source: string;
  lockfile?: string;
  lockfileVersion?: string;
  /** How packages are installed: a flat `node_modules`, pnpm's symlinked store, or Yarn Plug'n'Play */
  layout: 'node_modules' | 'pnpm-store' | 'pnp';
}

const read = (root: string, file: string): string | undefined => {
  try {
    return fs.readFileSync(join(root, file), 'utf8');
  } catch {
    return undefined;
  }
};
const has = (root: string, file: string): boolean => fs.existsSync(join(root, file));

/** `lockfileVersion` of an npm lockfile; a corrupt or empty one only costs the hint. */
function lockfileVersionOf(text: string | undefined): string {
  try {
    return String(JSON.parse(text ?? '{}').lockfileVersion ?? '');
  } catch {
    return '';
  }
}

/** Corepack's field: `pnpm@9.15.9+sha512.abc` -> { name: 'pnpm', version: '9.15.9' } */
function parsePackageManagerField(value: unknown): { name: string; version: string } | undefined {
  const match = typeof value === 'string' ? value.match(/^([^@]+)@([^+\s]+)/) : null;
  return match ? { name: match[1], version: match[2] } : undefined;
}

const PNPM_LOCKFILE_HINT: Record<string, string> = {
  '9.0': '9.x',
  '6.0': '8.x',
  '5.4': '7.x',
  '5.3': '6.x',
};
const YARN_BERRY_LOCKFILE_HINT: Record<string, string> = {
  '8': '4.x',
  '6': '3.x',
  '5': '2.x',
  '4': '2.x',
};

/**
 * Works out which package manager produced a project's dependencies, and its version, by reading files
 * only. A package manager is never executed: Yarn Berry would run the project's own `yarnPath` script.
 * Exact versions are recorded by few tools: pnpm writes its own (`node_modules/.modules.yaml`), Yarn
 * keeps it in `.yarnrc.yml`'s `yarnPath`, and any project may declare `packageManager`. npm, Yarn
 * classic and Yarn Berry otherwise leave only their lockfile format, reported as a hint.
 */
export function detectPackageManager(root: string): PackageManagerInfo {
  const declared = parsePackageManagerField(readPackageJson(root)?.packageManager);
  const pnp = has(root, '.pnp.cjs') || has(root, '.pnp.js') || has(root, '.pnp.data.json');
  const installedPnpm = read(root, 'node_modules/.modules.yaml')?.match(
    /^packageManager:\s*pnpm@(\S+)/m,
  )?.[1];
  const layout: PackageManagerInfo['layout'] = pnp
    ? 'pnp'
    : usesPnpmStore(root)
      ? 'pnpm-store'
      : 'node_modules';
  const yarnLock = read(root, 'yarn.lock');

  const pnpmEvidence = installedPnpm || has(root, 'pnpm-lock.yaml') || layout === 'pnpm-store';
  if (pnp || (!pnpmEvidence && yarnLock !== undefined)) {
    const berry = pnp || !/^# yarn lockfile v1/m.test(yarnLock ?? '');
    const lockVersion = berry ? yarnLock?.match(/^__metadata:\s*\n\s+version:\s*(\S+)/m)?.[1] : '1';
    // Berry: `yarnPath: .yarn/releases/yarn-4.5.3.cjs`; classic: `yarn-path ".yarn/releases/yarn-1.22.19.cjs"`
    const pathVersion = (read(root, berry ? '.yarnrc.yml' : '.yarnrc') ?? '').match(
      /yarn-(\d+\.\d+\.\d+)[^\s"']*\.c?js/,
    )?.[1];
    const fromField = declared?.name === 'yarn' ? declared.version : undefined;
    return {
      name: 'yarn',
      family: berry ? 'berry' : 'classic',
      version: pathVersion ?? fromField,
      versionHint:
        pathVersion || fromField
          ? undefined
          : berry
            ? YARN_BERRY_LOCKFILE_HINT[lockVersion ?? '']
            : '1.x',
      source: pathVersion
        ? 'yarnPath in the Yarn config'
        : fromField
          ? 'package.json packageManager'
          : pnp
            ? '.pnp.cjs'
            : 'yarn.lock',
      lockfile: yarnLock !== undefined ? 'yarn.lock' : undefined,
      lockfileVersion: lockVersion,
      layout,
    };
  }

  if (pnpmEvidence) {
    const lockVersion = read(root, 'pnpm-lock.yaml')?.match(
      /^lockfileVersion:\s*'?([\d.]+)'?/m,
    )?.[1];
    const fromField = declared?.name === 'pnpm' ? declared.version : undefined;
    const version = installedPnpm ?? fromField;
    return {
      name: 'pnpm',
      version,
      versionHint: version ? undefined : PNPM_LOCKFILE_HINT[lockVersion ?? ''],
      source: installedPnpm
        ? 'node_modules/.modules.yaml'
        : fromField
          ? 'package.json packageManager'
          : 'pnpm-lock.yaml',
      lockfile: has(root, 'pnpm-lock.yaml') ? 'pnpm-lock.yaml' : undefined,
      lockfileVersion: lockVersion,
      layout,
    };
  }

  const npmLock = has(root, 'package-lock.json')
    ? 'package-lock.json'
    : has(root, 'npm-shrinkwrap.json')
      ? 'npm-shrinkwrap.json'
      : undefined;
  if (npmLock || declared?.name === 'npm') {
    const lockVersion = npmLock ? lockfileVersionOf(read(root, npmLock)) : '';
    const fromField = declared?.name === 'npm' ? declared.version : undefined;
    return {
      name: 'npm',
      version: fromField,
      versionHint: fromField
        ? undefined
        : { '1': '5 or 6', '2': '7 or 8', '3': '7 or newer' }[lockVersion],
      source: fromField
        ? 'package.json packageManager'
        : (npmLock ?? 'package.json packageManager'),
      lockfile: npmLock,
      lockfileVersion: lockVersion || undefined,
      layout,
    };
  }

  // no lockfile or marker: a project installed without one, or one that only declares `packageManager`
  return {
    name:
      declared && ['npm', 'yarn', 'pnpm'].includes(declared.name)
        ? (declared.name as 'npm' | 'yarn' | 'pnpm')
        : 'unknown',
    version: declared?.version,
    source: declared ? 'package.json packageManager' : 'no lockfile found',
    layout,
  };
}

/** The exact version when known, else the hint (`4.x`), else nothing. */
export const packageManagerVersion = (pm: PackageManagerInfo): string =>
  pm.version ?? pm.versionHint ?? '';

const LAYOUT_NAMES: Record<PackageManagerInfo['layout'], string> = {
  node_modules: 'node_modules',
  'pnpm-store': 'pnpm virtual store',
  pnp: "Plug'n'Play",
};

/** `lockfile yarn.lock v8, Plug'n'Play layout`, for tooltips and summaries. */
export function describePackageManagerDetails(pm: PackageManagerInfo): string {
  const lock = pm.lockfile
    ? `lockfile ${pm.lockfile}${pm.lockfileVersion ? ` v${pm.lockfileVersion}` : ''}`
    : 'no lockfile';
  return `${lock}, ${LAYOUT_NAMES[pm.layout]} layout`;
}

/** `pnpm 9.15.9`, `Yarn 4.x (Berry)`, `npm 7 or newer`, `unknown` */
export function describePackageManager(pm: PackageManagerInfo): string {
  if (pm.name === 'unknown') return 'unknown';
  const name = pm.name === 'npm' ? 'npm' : pm.name === 'pnpm' ? 'pnpm' : 'Yarn';
  const version = packageManagerVersion(pm) || 'version not recorded';
  const family =
    pm.name === 'yarn' && pm.family === 'berry'
      ? ' (Berry)'
      : pm.name === 'yarn'
        ? ' (classic)'
        : '';
  return `${name} ${version}${family}`;
}
