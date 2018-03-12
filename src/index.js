const argv = require('yargs').argv;
const licenseFinder = require('./npm-license-tracker');
const exceptions = require('./exceptions');
const _noPathProvided = 'No path is provided'
const program = require('commander');

function startLicenseTracking(path, isProduction) {

  licenseFinder.findLicensesInfo(path, isProduction)
}

program
  .option('--path', '[required] Path to package json for package under consideration')
  .option('--isExcel', '[optional] To generate excel workbook on the results of npm license tracker')
  .on('--help', () => {
    console.log()
    console.log(`    Example:-
            $npm-license-tracker --path --isExcel`)
  })

module.exports = {
  run: function(path) {
    if(path == "" || path == null)
    {
      console.error(`${exceptions.NoProperArguments(_noPathProvided)}`);
    }
    else if (path.path === '--help') {
      program.outputHelp()
      return
    }
    else {
      console.info(`Paths to traverse:- ${path.path}`);
      startLicenseTracking(path, true);
    }
  }
}


