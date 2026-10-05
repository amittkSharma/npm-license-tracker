import { parse } from 'json2csv';
import { renderHtmlReport } from './html-report';
import { renderJUnitReport } from './junit-report';
import { renderMarkdownReport } from './markdown-report';
import { packageManagerVersion } from './package-manager';
import { REPORT_FIELDS, type ReportMeta } from './report-model';
import type { FormatFlag, FormatName, LicenseReport, RunOptions } from './types';

export interface Format {
  /** The option that switches this format on */
  option: FormatFlag;
  /** Used in console messages and as the name accepted by `formats` / `--format` */
  label: FormatName;
  /** File extension of `npm_licenses.<extension>` */
  extension: string;
  render(report: LicenseReport, meta: ReportMeta): string;
}

/** A flattened scoped package name such as `@babel-core`: harmless, and common, so it is left alone. */
const SCOPED_NAME = /^@[\w.~-]+-[\w.~-]+$/;

/**
 * Spreadsheets run a cell that starts with `= + - @` (or a tab / carriage return) as a formula, and package
 * metadata is written by whoever publishes the package. A leading `'` makes the cell plain text.
 */
export const neutralizeFormula = (value: string): string =>
  /^[=+\-@\t\r]/.test(value) && !SCOPED_NAME.test(value) ? `'${value}` : value;

/** A flat file has no header to put it in, so the package manager is two extra columns on every row. */
export const CSV_PACKAGE_MANAGER_COLUMNS = ['package manager', 'package manager version'];

const renderCsv = (report: LicenseReport): string => {
  const pm = report.license.packageManager;
  const rows = Object.values(report.license.packages)
    .map((entry) => ({
      ...entry,
      'package manager': pm?.name ?? '',
      'package manager version': pm ? packageManagerVersion(pm) : '',
    }))
    .map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, neutralizeFormula(String(v))])),
    );
  return parse(rows, { fields: [...REPORT_FIELDS, ...CSV_PACKAGE_MANAGER_COLUMNS], eol: '\n' });
};

/** The optional reports (JSON is always written). A new format is one renderer and one row here. */
export const FORMATS: Format[] = [
  { option: 'isExcel', label: 'csv', extension: 'csv', render: renderCsv },
  { option: 'isHtml', label: 'html', extension: 'html', render: renderHtmlReport },
  { option: 'isJunit', label: 'junit', extension: 'junit.xml', render: renderJUnitReport },
  { option: 'isMarkdown', label: 'markdown', extension: 'md', render: renderMarkdownReport },
];

/** `html,csv` / `html;csv` / `['html', 'csv']` -> `['html', 'csv']` (lower-cased). */
const formatNames = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/) : [])
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);

/**
 * The optional reports to write: those switched on by an `isXxx` option or named in `formats`
 * (`all` = every entry of FORMATS, so a new format is included automatically).
 */
export function selectFormats(options: Pick<RunOptions, FormatFlag | 'formats'>): Format[] {
  const requested = formatNames(options.formats);
  const unknown = requested.filter(
    (name) => name !== 'all' && !FORMATS.some((f) => f.label === name),
  );
  if (unknown.length) {
    const valid = [...FORMATS.map((f) => f.label), 'all'].join(', ');
    throw new Error(
      `Unknown format ${unknown.map((n) => `"${n}"`).join(', ')}. Valid formats: ${valid}`,
    );
  }
  return FORMATS.filter(
    (f) => requested.includes('all') || requested.includes(f.label) || options[f.option],
  );
}
