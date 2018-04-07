#!/usr/bin/env node
'use strict';

process.title = 'npm-license-tracker';

process.on('uncaughtException', function(err) {
  console.error('Caught exception:\n', err.stack);
});

var npmTracker = require('../dist/index.js');
var path = process.argv[2];
var isExcel = process.argv[3] ? process.argv[3] : false;
var parameter = { path, isExcel }

console.log(`path entered: ${parameter.path} and is excel needed: ${parameter.isExcel}`)

npmTracker.run(parameter);