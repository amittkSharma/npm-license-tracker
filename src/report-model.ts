import type { PolicyViolation } from './policy';
import type { LicenseReport, PackageEntry } from './types';

/**
 * Every property of a package entry, in report order. The JSON keeps this order by construction;
 * CSV, HTML, JUnit and Markdown read it from here, so all formats carry exactly the same fields.
 */
export const REPORT_FIELDS: (keyof PackageEntry)[] = [
  'package name',
  'licenses',
  'download url',
  'license file',
  'publisher',
  'description',
  'programming language',
  'package version',
  'publisher contact information',
  'dependencyType',
];

export interface ReportMeta {
  /** Shown in the report title */
  projectName: string;
  generatedAt: Date;
  violations?: PolicyViolation[];
}

interface ReportRow {
  /** Report key, `name:version` */
  key: string;
  entry: PackageEntry;
  violation?: PolicyViolation;
}

/** The report's packages, each paired with its policy violation (if any). */
export function reportRows(report: LicenseReport, meta: ReportMeta): ReportRow[] {
  const violations = new Map((meta.violations ?? []).map((v) => [v.package, v]));
  return Object.entries(report.license.packages).map(([key, entry]) => ({
    key,
    entry,
    violation: violations.get(key),
  }));
}

export const reportTitle = (meta: ReportMeta): string => `License Report for ${meta.projectName}`;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `YYYY-MM-DD`, in the reader's local time zone. */
export const reportDate = (date: Date): string =>
  `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** `YYYY-MM-DD_HH-mm-ss`, local time, with no character a file name cannot hold on any OS. */
export const reportTimestamp = (date: Date): string =>
  `${reportDate(date)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

/**
 * Name of a run's output folder: `<project name>_<timestamp>`. Characters file systems reject
 * (`/ \\ : * ? " < > |` and control characters) become `-`, so `@scope/pkg` is `@scope-pkg`.
 */
// File names are limited to 255 bytes (not characters); leave room for the timestamp and a `-N` suffix.
const MAX_NAME_BYTES = 200;

/** The longest prefix of `text` that fits in `limit` UTF-8 bytes, cut between whole characters. */
const truncateBytes = (text: string, limit: number): string => {
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > limit) break;
    out += ch;
  }
  return out;
};

export const runFolderName = (projectName: string, date: Date): string => {
  const safe = truncateBytes(fileSafe(projectName), MAX_NAME_BYTES).replace(/^[.\s]+|[.\s]+$/g, ''); // Windows drops trailing dots and spaces
  return `${safe || 'project'}_${reportTimestamp(date)}`;
};

const wrapsWhole = (text: string): boolean => {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0 && i < text.length - 1) return false;
  }
  return depth === 0;
};

/** `(MIT OR ISC)` -> `MIT OR ISC`; `(A) OR (B)` is left alone. Used for the license summaries. */
export const licenseLabel = (licenses: string): string => {
  let text = licenses.trim();
  while (text.startsWith('(') && text.endsWith(')') && wrapsWhole(text)) {
    text = text.slice(1, -1).trim();
  }
  return text;
};

/** Totals shown at the top of the human-readable reports. */
export function summarize(report: LicenseReport) {
  const entries = Object.values(report.license.packages);
  const direct = entries.filter((e) => e.dependencyType === 'direct').length;
  // grouped by display label, so `(MIT OR ISC)` and `MIT OR ISC` are one license
  const perLicense = new Map<string, number>();
  for (const e of entries) {
    const label = licenseLabel(e.licenses);
    perLicense.set(label, (perLicense.get(label) ?? 0) + 1);
  }
  const licenses = [...perLicense.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return { total: entries.length, direct, transitive: entries.length - direct, licenses };
}

/** Replaces what a file name cannot hold (`/ \\ : * ? " < > |`, control characters) with `-`. */
const fileSafe = (text: string): string =>
  Array.from(text)
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '-' : ch))
    .join('');

/**
 * Name of a package's license file inside `licenses/`: `<package name>@<version>`. Both parts come from a
 * dependency's package.json, which is untrusted, so neither can contain a path separator.
 */
export const licenseFileName = (entry: PackageEntry): string =>
  `${fileSafe(entry['package name'])}@${fileSafe(entry['package version'])}`;

/** The file name part of a path, for either path separator. */
export const fileBaseName = (path: string): string => path.split(/[\\/]/).pop() || path;

/** Formats that hold one field per line show a multi-line value on a single line. */
export const oneLine = (value: unknown): string =>
  String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ');

/** Only http(s) values become links: package metadata is untrusted (`javascript:` etc.). */
export const isLinkable = (value: string): boolean => /^https?:\/\/[^\s"'<>]+$/i.test(value);
