import * as exceptions from './exceptions';
import { findLicensesInfo } from './npm-license-tracker';
import type { RunOptions, RunResult } from './types';

export { IncompleteScanError, type ScanGap } from './completeness';
export { LicensePolicyError, type PolicyViolation } from './policy';
export type { RunOptions, RunResult } from './types';

const NO_PATH_PROVIDED = 'No path is provided';

/**
 * Generates the license report into a new folder (`<path>/npm_licenses/<package>_<datetime>`), and
 * resolves with that folder once everything is written. Rejects on failure, including a missing `path`.
 */
export async function run(params: RunOptions): Promise<RunResult> {
  if (!params?.path) {
    throw new Error(exceptions.NoProperArguments(NO_PATH_PROVIDED));
  }
  console.info(`Paths to traverse:- ${params.path}`);
  return findLicensesInfo(params);
}
