import { basename, join, resolve } from 'node:path';
import colors from 'colors';
import fs from 'fs-extra';
import { findScanGaps, IncompleteScanError, type ScanGap } from './completeness';
import { completeScan, type ScanDirectory } from './completion';
import * as exceptions from './exceptions';
import { type Format, selectFormats } from './formats';
import { realPath } from './fs-utils';
import { detectPackageManager, type PackageManagerInfo } from './package-manager';
import { scanPnp } from './pnp';
import { checkLicensePolicy, LicensePolicyError } from './policy';
import { licenseFileName, type ReportMeta, runFolderName } from './report-model';
import type {
  DeclaredDependency,
  LicenseInfo,
  LicenseMap,
  LicenseReport,
  PackageEntry,
  ProjectInfo,
  RunOptions,
  RunResult,
} from './types';
import { readVirtualFile } from './zip-fs';

const NO_INFO_FOUND = 'No information found';
const NO_FILE_FOUND = 'none';
const PLACEHOLDER_PREFIX = '<<Default';

// `publisher` and `email` are intentionally absent: license-checker fills them from the
// package's `author`, but a placeholder here would overwrite that real value.
const customFormat = {
  name: '<<Default Name>>',
  description: '<<Default Description>>',
  pewpew: '<<Should Never be set>>',
  licenses: '<<Default Licenses>>',
  version: '<<Default Version>>',
  licenseFile: 'none',
  licenseModified: 'no',
};

const fileOptions = {
  /** Parent of the per-run folders, inside the project */
  outputFolderName: 'npm_licenses',
  /** Sub-folder (inside the output folder) holding the copied license files */
  licensesFolderName: 'licenses',
  /** The reports are `<reportName>.<extension>`, in the output folder itself */
  reportName: 'npm_licenses',
};

/** license-checker's placeholder (or an empty value) means "not provided". */
const provided = <T>(value: T | undefined): T | undefined =>
  value === undefined ||
  value === '' ||
  (typeof value === 'string' && value.startsWith(PLACEHOLDER_PREFIX))
    ? undefined
    : value;

/** license-checker returns a string, or an array for packages with several licenses. */
export function normalizeLicenses(licenses: string | string[] | undefined): string {
  const list = ([] as (string | undefined)[]).concat(licenses).map(provided);
  const names = list.filter((l): l is string => !!l);
  return names.length ? names.join(' OR ') : NO_INFO_FOUND;
}

/** Accepts a list, or a `;`-separated string (the CLI form); anything else is an empty list. */
export function toList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(';') : [];
  return items.map((item) => String(item).trim()).filter(Boolean);
}

/** The subset of license-checker-rseidelsohn's init() options we use. */
interface InitOpts {
  start: string;
  json: boolean;
  customFormat: Record<string, string>;
  production?: boolean;
  excludePrivatePackages?: boolean;
  excludePackages?: string;
  clarificationsFile?: string;
}

type ScanOptions = Pick<
  RunOptions,
  'production' | 'excludePrivatePackages' | 'excludePackages' | 'clarificationsFile'
>;

/**
 * Fails early, with a clear message, on a clarifications file license-checker would silently
 * ignore (unreadable/invalid JSON) or would answer by killing the process (a `checksum` mismatch).
 */
export function validateClarificationsFile(file: string): void {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read clarifications file ${file}: ${err}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Clarifications file ${file} must be a JSON object keyed by "name@version"`);
  }
  for (const [key, entry] of Object.entries(data)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Clarifications file ${file}: entry "${key}" must be an object`);
    }
    if ('checksum' in entry) {
      throw new Error(
        `Clarifications file ${file}: entry "${key}" uses "checksum", which is not supported (a mismatch would terminate the process); remove it`,
      );
    }
  }
}

export async function findLicenses(path: string, scan: ScanOptions = {}): Promise<LicenseMap> {
  const options: InitOpts = { json: true, start: path, customFormat };
  if (scan.production) options.production = true;
  if (scan.excludePrivatePackages) options.excludePrivatePackages = true;
  const excluded = toList(scan.excludePackages);
  if (excluded.length) options.excludePackages = excluded.join(';');
  // validated once by findLicensesInfo: this runs for every package folder in pnpm and Plug'n'Play projects
  if (scan.clarificationsFile) options.clarificationsFile = resolve(scan.clarificationsFile);
  // license-checker-rseidelsohn is ESM-only; a dynamic import() loads it from our CommonJS build
  // on every supported Node version (a plain require() only works on Node >= 20.19).
  const { init } = await import('license-checker-rseidelsohn');
  return new Promise((resolve, reject) => {
    init(options, (err, licenseMap) => {
      // a project with no dependencies (or a name npm rejects, such as "My App") has nothing to report
      if (err && /No packages found/.test(String(err))) {
        resolve({});
        return;
      }
      if (err) {
        reject(new Error(exceptions.ErrorInReadingNpmPackages(path, err)));
        return;
      }
      resolve(licenseMap as unknown as LicenseMap);
    });
  });
}

/**
 * Locations of the project's own declared dependencies. A package is "direct" when it is the
 * one installed at `<project>/node_modules/<declared name>`, whatever version range was declared
 * (`^`, `~`, `>=`, tags, aliases...). Symlinked installs (pnpm, npm link) are compared by real path.
 */
function declaredLocations(root: string, declared: DeclaredDependency[]): Set<string> {
  return new Set(declared.map((d) => realPath(join(root, 'node_modules', d.name))));
}

export function getExtendedJson(
  path: string,
  json: LicenseMap,
  declared: DeclaredDependency[],
  rootKey?: string,
  packageManager?: PackageManagerInfo,
): LicenseReport {
  const directLocations = declaredLocations(path, declared);
  const entries = Object.keys(json)
    .filter((key) => key !== rootKey)
    .map((key): PackageEntry => {
      const info: LicenseInfo = json[key];
      const repoName = info.repository ? info.repository.replace('git+', '') : NO_INFO_FOUND;
      const name = provided(info.name);
      return {
        'package name': name ? name.replace(/[\\/]/g, '-') : NO_INFO_FOUND,
        licenses: normalizeLicenses(info.licenses),
        'download url': repoName,
        'license file': info.licenseFile,
        publisher:
          provided(info.publisher) ??
          (info.repository ? info.repository.split('/').slice(-2, -1)[0] : undefined) ??
          NO_INFO_FOUND,
        description: provided(info.description) ?? NO_INFO_FOUND,
        'programming language': 'JavaScript',
        'package version': provided(info.version) ?? NO_INFO_FOUND,
        'publisher contact information': provided(info.email) ?? repoName,
        dependencyType:
          (info.direct ??
          (info.path
            ? directLocations.has(realPath(info.path))
            : declared.some((d) => d.label === key)))
            ? 'direct'
            : 'transitive',
      };
    });

  const packages: Record<string, PackageEntry> = {};
  for (const entry of entries) {
    packages[`${entry['package name']}:${entry['package version']}`] = entry;
  }

  return { license: { path, ...(packageManager && { packageManager }), packages } };
}

async function writeFormat(
  format: Format,
  file: string,
  report: LicenseReport,
  meta: ReportMeta,
): Promise<void> {
  console.log(colors.yellow(`Start writing npm license ${format.label}`));
  try {
    await fs.writeFile(file, format.render(report, meta));
  } catch (err) {
    throw new Error(`Unable to generate the ${format.label} file due to ${err}`);
  }
  console.log(colors.green(`${format.label} file is created at`), file);
}

/**
 * Creates `<parent>/<name>` and returns it. The name is claimed atomically (`mkdir` fails if it
 * exists), so a taken name gets `-2`, `-3`, ... and no run ever reuses or overwrites another's folder.
 */
export async function createRunFolder(parent: string, name: string): Promise<string> {
  await fs.ensureDir(parent);
  for (let attempt = 1; ; attempt++) {
    const folder = join(parent, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      await fs.mkdir(folder);
      return folder;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export async function writeReports(
  report: LicenseReport,
  formats: Format[],
  meta: ReportMeta,
  /** Where run folders are created; defaults to `<project>/npm_licenses` */
  outputDir?: string,
): Promise<{
  destinationFolder: string;
  updatedResult: LicenseReport;
  /** Settle when the optional reports are written; empty when none were requested. */
  extras: Promise<void>[];
}> {
  const parent = resolve(outputDir ?? join(report.license.path, fileOptions.outputFolderName));
  let destinationFolder: string;
  try {
    destinationFolder = await createRunFolder(
      parent,
      runFolderName(meta.projectName, meta.generatedAt),
    );
  } catch (err) {
    throw new Error(`${exceptions.ErrorInWritingFile(parent)} (${err})`);
  }
  console.log(colors.green('Output folder:'), destinationFolder);
  const reportFile = (extension: string) =>
    join(destinationFolder, `${fileOptions.reportName}.${extension}`);
  try {
    await fs.outputJson(reportFile('json'), report, { spaces: 2 });
  } catch (err) {
    throw new Error(`${exceptions.ErrorInWritingFile(reportFile('json'))} (${err})`);
  }
  // Not awaited here so the console order stays: "Start writing csv", "JSON file is created", ...
  const extras = formats.map((f) => writeFormat(f, reportFile(f.extension), report, meta));
  return { destinationFolder, updatedResult: report, extras };
}

/**
 * Maps output file name -> source license file. Files are always named `<name>@<version>`, so the
 * name is predictable and several versions of a package never overwrite each other.
 */
export function planLicenseFiles(packages: Record<string, PackageEntry>): {
  files: Record<string, string>;
  missing: string[];
} {
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of Object.keys(packages)) {
    const pkg = packages[key];
    const licenseFile = pkg['license file'];
    if (!licenseFile || licenseFile === NO_FILE_FOUND) {
      missing.push(key);
    } else {
      files[licenseFileName(pkg)] = licenseFile;
    }
  }
  return { files, missing };
}

/** Copies a license file; one inside a Yarn zip archive (`x.zip/node_modules/y/LICENSE`) is read from it. */
async function copyLicenseFile(src: string, dest: string): Promise<void> {
  const data = fs.existsSync(src) ? undefined : readVirtualFile(src);
  if (data) await fs.outputFile(dest, data);
  else await fs.copy(src, dest);
}

async function copyLicenseFiles(
  destinationFolder: string,
  updatedResult: LicenseReport,
): Promise<void> {
  const { files, missing } = planLicenseFiles(updatedResult.license.packages);
  for (const key of missing) {
    console.log(colors.red('No license file is available for package:'), key);
  }
  try {
    await Promise.all(
      Object.entries(files).map(([name, src]) =>
        copyLicenseFile(src, join(destinationFolder, fileOptions.licensesFolderName, name)),
      ),
    );
  } catch (err) {
    throw new Error(`Error in copying files: ${err}`);
  }
  console.log(colors.green('All licenses files copied successfully.'));
  console.log(
    colors.green(
      `Total licenses file copied successfully: ${Object.keys(files).length} and failed:${missing.length} :`,
    ),
  );
}

/** Only a plain `name: "range"` object is a dependency list; anything else in package.json is ignored. */
const declaredEntries = (value: unknown): [string, string][] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')
    : [];

export function getDependencies(
  dependencies?: unknown,
  devDependencies?: unknown,
  optionalDependencies?: unknown,
  peerDependencies?: unknown,
): DeclaredDependency[] {
  const toDeclared =
    (type: DeclaredDependency['type']) =>
    ([name, version]: [string, string]): DeclaredDependency => {
      const label = version.indexOf('^') >= 0 ? version.slice(1) : version;
      return { name, version, label: `${name}@${label}`, type };
    };
  return [
    ...declaredEntries(dependencies).map(toDeclared('dependency')),
    ...declaredEntries(devDependencies).map(toDeclared('devDependency')),
    ...declaredEntries(optionalDependencies).map(toDeclared('optionalDependency')),
    ...declaredEntries(peerDependencies).map(toDeclared('peerDependency')),
  ];
}

export async function readModulePackageJson(path: string): Promise<ProjectInfo> {
  const packageData = fs.readJsonSync(`${path}/package.json`, { throws: false });
  if (packageData === null || typeof packageData !== 'object' || Array.isArray(packageData)) {
    throw new Error(
      `Not able to read the package file: ${path}/package.json (it must hold a JSON object)`,
    );
  }
  return {
    name:
      typeof packageData.name === 'string' && packageData.name
        ? packageData.name
        : basename(resolve(path)),
    rootKey:
      packageData.name && packageData.version
        ? `${packageData.name}@${packageData.version}`
        : undefined,
    declared: getDependencies(
      packageData.dependencies,
      packageData.devDependencies,
      packageData.optionalDependencies,
      packageData.peerDependencies,
    ),
  };
}

export async function findLicensesInfo(parameter: RunOptions): Promise<RunResult> {
  const { path } = parameter;
  const formats = selectFormats(parameter); // before any work, so a typo fails fast
  if (parameter.clarificationsFile)
    validateClarificationsFile(resolve(parameter.clarificationsFile));
  const { name, declared, rootKey } = await readModulePackageJson(path);
  const scanOptions = { ...parameter, excludePackages: toList(parameter.excludePackages) };
  const scanDirectory: ScanDirectory = (dir) =>
    findLicenses(dir, { ...parameter, production: false });
  let result: LicenseMap;
  let gaps: ScanGap[];
  const packageManager = detectPackageManager(path);
  if (packageManager.layout === 'pnp') {
    // Yarn Plug'n'Play has no node_modules: the packages are listed in .pnp.cjs and live in zip archives
    ({ result, gaps } = await scanPnp(path, declared, scanOptions, scanDirectory));
  } else {
    // the scanner reads node_modules; a layout it only partly reads (pnpm's symlinked store) is completed
    const scanned = await findLicenses(path, parameter);
    result = await completeScan(path, declared, scanned, scanOptions, scanDirectory);
    gaps = findScanGaps(path, declared, result, scanOptions);
  }
  if (gaps.length) {
    // fail before anything is written, unless the user explicitly accepts an incomplete report
    if (!parameter.allowIncomplete) throw new IncompleteScanError(gaps);
    console.warn(colors.yellow(`Warning: ${new IncompleteScanError(gaps).message}`));
  }
  const report = getExtendedJson(path, result, declared, rootKey, packageManager);
  // evaluated up front (the JUnit/HTML reports show it) but thrown last, so reports are always written
  const violations = checkLicensePolicy(report.license.packages, {
    failOn: toList(parameter.failOn),
    onlyAllow: toList(parameter.onlyAllow),
  });
  const written = await writeReports(
    report,
    formats,
    { projectName: name, generatedAt: new Date(), violations },
    parameter.outputDir,
  );
  console.log(colors.green('JSON file is created'));
  const outcomes = await Promise.allSettled([
    ...written.extras,
    copyLicenseFiles(written.destinationFolder, written.updatedResult),
  ]);
  const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
  if (failed) throw failed.reason;
  if (violations.length) throw new LicensePolicyError(violations, written.destinationFolder);
  return { outputFolder: written.destinationFolder };
}
