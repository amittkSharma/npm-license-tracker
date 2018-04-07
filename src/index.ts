import { exceptions } from './exception'
import { findLicensesInfo  } from './npm-license-tracker'
const _noPathProvided = 'No path is provided'

function startLicenseTracking(path, isProduction) {
  findLicensesInfo({path, isProduction})
  console.dir('in the start function')
}

export function run(path): void {
  if (path === '' || path == null)
  {
    console.error(`${exceptions.NoProperArguments(_noPathProvided)}`)
  }
  else {
    console.info(`Paths to traverse:- ${path.path}`)
    startLicenseTracking(path, true)
  }
}
