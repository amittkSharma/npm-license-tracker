import type { PackageManagerInfo } from './package-manager';

/** Options that switch an optional report format on */
export type FormatFlag = 'isExcel' | 'isHtml' | 'isJunit' | 'isMarkdown';

/** Names accepted by the `formats` option (`all` selects every one of them) */
export type FormatName = 'csv' | 'html' | 'junit' | 'markdown';

export interface RunOptions {
  /** Path to the project directory containing package.json */
  path: string;
  /** Also generate a CSV report. Defaults to false. */
  isExcel?: boolean;
  /** Also generate a self-contained HTML report. Defaults to false. */
  isHtml?: boolean;
  /** Also generate a JUnit XML report (for Azure DevOps and other CI). Defaults to false. */
  isJunit?: boolean;
  /** Also generate a Markdown report. Defaults to false. */
  isMarkdown?: boolean;
  /** Reports to generate besides the JSON: `'all'`, or a list such as `['html', 'csv']` (the CLI's `--format`). Combines with the `isXxx` options. */
  formats?: 'all' | FormatName[];
  /** Write the report even if the scan is incomplete (missing or unreadable dependencies). A warning is printed. */
  allowIncomplete?: boolean;
  /** Folder to create the run folder in. Defaults to `<path>/npm_licenses`, inside the scanned project. */
  outputDir?: string;
  /** Skip devDependencies (and everything only they pull in) */
  production?: boolean;
  /** Skip packages marked `"private": true` */
  excludePrivatePackages?: boolean;
  /** Skip packages: `name`, `name@major` or `name@version` */
  excludePackages?: string[];
  /** JSON file with license clarifications for packages whose license cannot be detected */
  clarificationsFile?: string;
  /** Fail (after writing the report) if any package carries one of these licenses */
  failOn?: string[];
  /** Fail (after writing the report) if a package carries none of these licenses */
  onlyAllow?: string[];
}

export interface DeclaredDependency {
  name: string;
  version: string;
  label: string;
  /** `optionalDependency` and `peerDependency` may legitimately be absent from node_modules */
  type: 'dependency' | 'devDependency' | 'optionalDependency' | 'peerDependency';
}

/** Per-package entry as returned by license-checker with our custom format. */
export interface LicenseInfo {
  name?: string;
  licenses?: string | string[];
  repository?: string;
  licenseFile?: string;
  publisher?: string;
  email?: string;
  description?: string;
  version?: string;
  /** Directory the package is installed in */
  path?: string;
  /** Set by readers that know the dependency graph (Plug'n'Play): declared by the project itself */
  direct?: boolean;
}

export type LicenseMap = Record<string, LicenseInfo>;

export interface PackageEntry {
  'package name': string;
  /** Always a string; several licenses are joined as `MIT OR ISC` */
  licenses: string;
  'download url': string;
  'license file'?: string;
  publisher: string | undefined;
  description?: string;
  'programming language': 'JavaScript';
  'package version': string;
  'publisher contact information': string;
  dependencyType: 'direct' | 'transitive';
}

export interface LicenseReport {
  license: {
    path: string;
    /** Which package manager installed the scanned dependencies, and its version when known */
    packageManager?: PackageManagerInfo;
    packages: Record<string, PackageEntry>;
  };
}

/** What `run()` resolves with. */
export interface RunResult {
  /** The folder created for this run, holding the reports and `licenses/` (absolute) */
  outputFolder: string;
}

/** What we need from the target project's own package.json. */
export interface ProjectInfo {
  /** The project's `name` (its directory name when package.json has none) */
  name: string;
  /** license-checker key of the project itself (`name@version`), if it has both */
  rootKey?: string;
  declared: DeclaredDependency[];
}
