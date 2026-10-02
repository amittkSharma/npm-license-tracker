import { packageManagerVersion } from './package-manager';
import { ruleText } from './policy';
import { oneLine, REPORT_FIELDS, type ReportMeta, reportRows, reportTitle } from './report-model';
import type { LicenseReport } from './types';

// XML 1.0 forbids most control characters and lone surrogates; package metadata is untrusted.
const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

const stripInvalidXml = (value: string): string =>
  Array.from(value)
    .filter((ch) => isXmlChar(ch.codePointAt(0) as number))
    .join('');

const escapeXml = (value: unknown): string =>
  stripInvalidXml(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');

/** Text-node variant: keeps real line breaks, escapes only what XML requires. */
const escapeText = (value: unknown): string =>
  stripInvalidXml(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Renders JUnit XML (schema: junit-10.xsd, as consumed by Azure DevOps "Publish Test Results"):
 * one test case per package, named `<package name>@<version>` and grouped by license (`classname`).
 * Every field of the JSON entry is listed in the test case's `system-out`, in report order.
 * A package that breaks the failOn / onlyAllow policy is a failed test; otherwise all tests pass.
 */
const properties = (report: LicenseReport): string => {
  const pm = report.license.packageManager;
  if (!pm) return '';
  const props: [string, string | undefined][] = [
    ['packageManager', pm.name],
    ['packageManagerVersion', packageManagerVersion(pm) || undefined],
    ['lockfile', pm.lockfile],
    ['layout', pm.layout],
  ];
  const lines = props
    .filter((p): p is [string, string] => !!p[1])
    .map(([name, value]) => `      <property name="${name}" value="${escapeXml(value)}"/>`);
  return `    <properties>\n${lines.join('\n')}\n    </properties>\n`;
};

export function renderJUnitReport(report: LicenseReport, meta: ReportMeta): string {
  const rows = reportRows(report, meta);
  const failures = rows.filter((r) => r.violation).length;

  const cases = rows
    .map(({ key, entry, violation: v }) => {
      const failure = v
        ? `\n      <failure message="${escapeXml(`${ruleText[v.rule]}: ${v.licenses}`)}" type="LicensePolicyViolation">${escapeText(`${key} (${v.licenses}): ${ruleText[v.rule]}`)}</failure>`
        : '';
      const out = REPORT_FIELDS.map((f) => `${f}: ${oneLine(entry[f])}`).join('\n');
      return `    <testcase classname="${escapeXml(entry.licenses)}" name="${escapeXml(`${entry['package name']}@${entry['package version']}`)}" time="0">${failure}
      <system-out>${escapeText(out)}</system-out>
    </testcase>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${escapeXml(reportTitle(meta))}" tests="${rows.length}" failures="${failures}" errors="0" time="0">
  <testsuite name="${escapeXml(reportTitle(meta))}" tests="${rows.length}" failures="${failures}" errors="0" skipped="0" time="0" timestamp="${escapeXml(meta.generatedAt.toISOString())}">
${properties(report)}${cases}
  </testsuite>
</testsuites>
`;
}
