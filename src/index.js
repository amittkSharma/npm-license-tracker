const licenseFinder = require('./npm-license-tracker');
const exceptions = require('./exceptions');
const _noPathProvided = 'No path is provided'

function startLicenseTracking(path, isProduction) {
  licenseFinder.findLicensesInfo(path)
}

module.exports = {
  run: function(params) {
    if (params == "" || params == null) {
      console.error(`${exceptions.NoProperArguments(_noPathProvided)}`);
    } else {
      console.info(`Paths to traverse:- ${params.path}`);
      startLicenseTracking(params, true);
    }
  }
}
