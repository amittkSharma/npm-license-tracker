#!/usr/bin/env node
'use strict';

const { program } = require('commander');

process.title = 'npm-license-tracker';

process.on('uncaughtException', function(err) {
  console.error('Caught exception:\n', err.stack);
});

program
  .option('--path <path>', '[required] Path to package json for package under consideration')
  .option('--isExcel', '[optional] To generate excel workbook on the results of npm license tracker')
  .on('--help', () => {
    console.log();
    console.log('    Example:-');
    console.log('            $npm-license-tracker --path /path/to/project --isExcel');
  });

program.parse(process.argv);

const options = program.opts();

if (!options.path) {
  console.error('Error: --path is required');
  program.outputHelp();
  process.exit(1);
}

var npmTracker = require('../src/index.js');
npmTracker.run({ path: options.path, isExcel: options.isExcel || false });
