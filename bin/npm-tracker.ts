#!/usr/bin/env node
import { program } from 'commander';
import { run } from '../src/index';
import { toList } from '../src/npm-license-tracker';
import type { RunOptions } from '../src/types';

process.title = 'npm-license-tracker';

process.on('uncaughtException', (err) => {
  console.error('Caught exception:\n', err.stack);
  process.exitCode = 1;
});

program
  .name('npm-tracker')
  .description('Write a license report for every dependency of a project (npm, Yarn and pnpm).')
  .option('--path <folder>', 'The project to scan: the folder that has package.json (required)')
  .option(
    '--format <list>',
    'Reports to write besides the JSON: csv, html, junit, markdown (comma-separated), or "all"',
  )
  .option(
    '--outputDir <folder>',
    'Where to put the results (default: npm_licenses inside the project)',
  )
  .option('--production', 'Skip devDependencies and anything only they need')
  .option(
    '--failOn <list>',
    'Exit 1 if a package has one of these licenses, e.g. "GPL-3.0;AGPL-3.0"',
  )
  .option('--onlyAllow <list>', 'Exit 1 unless every package\'s license is covered, e.g. "MIT;ISC"')
  .option('--excludePrivatePackages', 'Leave out packages marked "private": true')
  .option(
    '--excludePackages <list>',
    'Leave out packages by full name: "name", "name@major" or "name@version", separated by ";"',
  )
  .option('--clarificationsFile <file>', 'JSON file that states licenses the tool cannot detect')
  .option(
    '--allowIncomplete',
    'Write the report even if some dependencies are missing or unreadable (prints a warning)',
  )
  .option('--isExcel', 'Same as --format csv')
  .option('--isHtml', 'Same as --format html')
  .option('--isJunit', 'Same as --format junit')
  .option('--isMarkdown', 'Same as --format markdown')
  .addHelpText(
    'after',
    `
Examples:
  npm-tracker --path . --format all
  npm-tracker --path . --production --format html,markdown
  npm-tracker --path . --failOn "GPL-3.0;AGPL-3.0"

Every run writes to a new folder and prints where. Exit code 1 means a --failOn / --onlyAllow rule
matched, the scan was incomplete (a dependency is missing or unreadable), or something failed.`,
  );

program.parse(process.argv);

const options = program.opts<{
  path?: string;
  isExcel?: boolean;
  isHtml?: boolean;
  isJunit?: boolean;
  isMarkdown?: boolean;
  format?: string;
  outputDir?: string;
  allowIncomplete?: boolean;
  production?: boolean;
  excludePrivatePackages?: boolean;
  excludePackages?: string;
  clarificationsFile?: string;
  failOn?: string;
  onlyAllow?: string;
}>();

if (!options.path) {
  console.error('Error: --path is required');
  program.outputHelp();
  process.exit(1);
}

run({
  path: options.path,
  isExcel: options.isExcel || false,
  isHtml: options.isHtml || false,
  isJunit: options.isJunit || false,
  isMarkdown: options.isMarkdown || false,
  formats: options.format as RunOptions['formats'], // validated by run()
  outputDir: options.outputDir,
  allowIncomplete: options.allowIncomplete,
  production: options.production,
  excludePrivatePackages: options.excludePrivatePackages,
  excludePackages: toList(options.excludePackages),
  clarificationsFile: options.clarificationsFile,
  failOn: toList(options.failOn),
  onlyAllow: toList(options.onlyAllow),
}).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
