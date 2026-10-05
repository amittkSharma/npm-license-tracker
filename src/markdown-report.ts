import { describePackageManager, describePackageManagerDetails } from './package-manager';
import { ruleText } from './policy';
import {
  isLinkable,
  oneLine,
  REPORT_FIELDS,
  type ReportMeta,
  reportDate,
  reportRows,
  reportTitle,
  summarize,
} from './report-model';
import type { LicenseReport, PackageEntry } from './types';

/** Backslash-escapes what would be read as Markdown or HTML (and `|`, which ends a table cell). */
const escapeMd = (value: unknown): string => oneLine(value).replace(/[\\`*_[\]<>|&~]/g, '\\$&');

const cell = (field: keyof PackageEntry, value: unknown): string => {
  const text = oneLine(value);
  // an autolink; a pipe inside it must still be escaped for the table
  return field === 'download url' && isLinkable(text)
    ? `<${text.replace(/\|/g, '\\|')}>`
    : escapeMd(text);
};

const table = (head: string[], body: string[][]): string =>
  [head, head.map(() => '---'), ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');

/** Renders GitHub-flavoured Markdown with the same fields as the JSON. */
export function renderMarkdownReport(report: LicenseReport, meta: ReportMeta): string {
  const rows = reportRows(report, meta);
  const violations = meta.violations ?? [];
  const { total, direct, transitive, licenses } = summarize(report);
  const pm = report.license.packageManager;

  const sections = [
    `# ${escapeMd(reportTitle(meta))}\n\nDate: ${reportDate(meta.generatedAt)}`,
    [
      '## Summary',
      `- **Packages:** ${total} (${direct} direct, ${transitive} transitive)`,
      `- **Distinct licenses:** ${licenses.length}`,
      ...(pm
        ? [
            `- **Package manager:** ${escapeMd(describePackageManager(pm))}; ${escapeMd(describePackageManagerDetails(pm))}`,
          ]
        : []),
      `- **Policy violations:** ${violations.length}`,
    ].join('\n'),
  ];
  if (violations.length) {
    sections.push(
      [
        `## License policy violated by ${violations.length} package(s)`,
        ...violations.map(
          (v) => `- **${escapeMd(v.package)}** (${escapeMd(v.licenses)}): ${ruleText[v.rule]}`,
        ),
      ].join('\n'),
    );
  }
  sections.push(
    // the blank lines are required: without them a table inside <details> is not rendered
    `<details open>\n<summary><b>Licenses</b></summary>\n\n${table(
      ['License', 'Packages'],
      licenses.map(([name, n]) => [escapeMd(name), String(n)]),
    )}\n\n</details>`,
    `## Packages\n\n${table(
      REPORT_FIELDS,
      rows.map(({ entry }) => REPORT_FIELDS.map((f) => cell(f, entry[f]))),
    )}`,
  );
  return `${sections.join('\n\n')}\n`;
}
