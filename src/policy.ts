import type { PackageEntry } from './types';

interface PolicyRules {
  /** Fail when a package carries any of these licenses */
  failOn?: string[];
  /** Fail when a package carries none of these licenses */
  onlyAllow?: string[];
}

export interface PolicyViolation {
  /** Report key, `name:version` */
  package: string;
  licenses: string;
  rule: 'failOn' | 'onlyAllow';
}

/** Human wording of each rule, shared by the error message and every report. */
export const ruleText = {
  failOn: 'license is on the failOn list',
  onlyAllow: 'not allowed by the onlyAllow list',
} as const;

export class LicensePolicyError extends Error {
  readonly violations: PolicyViolation[];
  /** Where this run's reports were written (the reports are written before the policy is enforced) */
  readonly outputFolder?: string;

  constructor(violations: PolicyViolation[], outputFolder?: string) {
    const lines = violations.map((v) => `  ${v.package} (${v.licenses}): ${ruleText[v.rule]}`);
    super(`License policy violated by ${violations.length} package(s):\n${lines.join('\n')}`);
    this.name = 'LicensePolicyError';
    this.violations = violations;
    this.outputFolder = outputFolder;
  }
}

/** A license expression: a license id, or two expressions joined by AND / OR. */
type Expr = { id: string } | { op: 'and' | 'or'; left: Expr; right: Expr };

/**
 * Lower-cased id, comparable between expression and policy list: the guessed-license `*` marker
 * is dropped and `GPL-2.0+` means `GPL-2.0-or-later`. (No version-range expansion: ids match exactly.)
 */
const normalizeId = (id: string): string =>
  id.trim().replace(/\*$/, '').replace(/\+$/, '-or-later').toLowerCase();

/**
 * Parses `MIT`, `(MIT OR ISC) AND BSD-3-Clause`, `GPL-2.0 WITH Classpath-exception-2.0` (AND binds
 * tighter than OR, as in SPDX). It does not validate ids: the scanner also reports `UNKNOWN`, `BSD*`
 * and free text such as `Custom: https://...`. Returns undefined when it is not a well-formed expression.
 */
function parseExpression(text: string): Expr | undefined {
  const tokens =
    text
      .trim()
      .replace(/\*$/, '')
      .match(/\(|\)|[^\s()]+/g) ?? []; // `(A OR B)*` is a guess
  const keyword = (t: string | undefined) => t?.toUpperCase();
  let i = 0;

  const parseOr = (): Expr | undefined => {
    let left = parseAnd();
    while (left && keyword(tokens[i]) === 'OR') {
      i++;
      const right = parseAnd();
      if (!right) return undefined;
      left = { op: 'or', left, right };
    }
    return left;
  };
  const parseAnd = (): Expr | undefined => {
    let left = parseAtom();
    while (left && keyword(tokens[i]) === 'AND') {
      i++;
      const right = parseAtom();
      if (!right) return undefined;
      left = { op: 'and', left, right };
    }
    return left;
  };
  const parseAtom = (): Expr | undefined => {
    const token = tokens[i];
    if (
      token === undefined ||
      token === ')' ||
      ['AND', 'OR', 'WITH'].includes(keyword(token) ?? '')
    ) {
      return undefined;
    }
    i++;
    if (token === '(') {
      const inner = parseOr();
      if (!inner || tokens[i] !== ')') return undefined;
      i++;
      return inner;
    }
    if (keyword(tokens[i]) === 'WITH') {
      if (tokens[i + 1] === undefined) return undefined;
      i += 2; // an exception narrows the obligations of the license; the license itself still applies
    }
    return { id: normalizeId(token) };
  };

  const expr = parseOr();
  return expr && i === tokens.length ? expr : undefined;
}

/** What is not an expression (`Custom: ...`, `UNKNOWN`...) is treated as one opaque license id. */
const toExpr = (licenses: string): Expr =>
  parseExpression(licenses) ?? { id: normalizeId(licenses) };

const leaves = (expr: Expr): string[] =>
  'id' in expr ? [expr.id] : [...leaves(expr.left), ...leaves(expr.right)];

/** Whether the expression can be satisfied using only the allowed licenses: OR needs one side, AND both. */
const satisfied = (expr: Expr, allowed: Set<string>): boolean =>
  'id' in expr
    ? allowed.has(expr.id)
    : expr.op === 'or'
      ? satisfied(expr.left, allowed) || satisfied(expr.right, allowed)
      : satisfied(expr.left, allowed) && satisfied(expr.right, allowed);

/**
 * Evaluates the license policy. License ids compare case-insensitively (SPDX ids are).
 * - failOn: violated when ANY license in the expression is listed (conservative: `MIT OR GPL-3.0`
 *   counts as GPL-3.0, even though the MIT option exists)
 * - onlyAllow: violated unless the expression can be satisfied with the allowed licenses: an `OR` needs
 *   one allowed side, an `AND` needs both. Unknown licenses never match.
 */
export function checkLicensePolicy(
  packages: Record<string, PackageEntry>,
  { failOn = [], onlyAllow = [] }: PolicyRules,
): PolicyViolation[] {
  const denied = new Set(failOn.map(normalizeId).filter(Boolean));
  const allowed = new Set(onlyAllow.map(normalizeId).filter(Boolean));
  const violations: PolicyViolation[] = [];
  for (const [key, pkg] of Object.entries(packages)) {
    const expr = toExpr(pkg.licenses);
    if (denied.size && leaves(expr).some((id) => denied.has(id))) {
      violations.push({ package: key, licenses: pkg.licenses, rule: 'failOn' });
    } else if (allowed.size && !satisfied(expr, allowed)) {
      violations.push({ package: key, licenses: pkg.licenses, rule: 'onlyAllow' });
    }
  }
  return violations;
}
