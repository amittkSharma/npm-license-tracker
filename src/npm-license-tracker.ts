
import * as licenseChecker from 'license-checker'
import * as fs from 'fs-extra'
import * as copy from 'copy-files'
import * as json2csv from 'json2csv'

const _noInfoFound = 'No information found'
const _noFileFound = 'none'
const options = {
  json: true,
  production : true,
  development: true,
  start: '',
  customFormat: {
    name: '',
    version: '',
    description: '',
    licenses: '',
    publisher: '',
    email: '',
    licenseFile: 'none',
    licenseModified: 'no',
  },
}

const fileOptions = {
  outputFolderName: '/npm_licenses/',
  outputFileName: 'npm_licenses.json',
}

function licenseFinder(path) {
  const p =  new Promise((resolve, reject) => {
    licenseChecker.init(options, (licenseMap, err) => {
      if (err) {
        reject(`error occured in reading npm packages ${err}`)
      }
      resolve(licenseMap)
    })
  })
  return p
}

function getExtendedJson(path, json, packages) {
  const updatedpackages = Object.keys(json).map(x => {
    const info = json[x]
    const repoName = info.repository ? info.repository.replace('git+', '') : _noInfoFound
    return {
      'package name': info.name.indexOf('/') >= 0 ? info.name.replace('/', '-') : info.name,
      'licenses': info.licenses,
      'download url': repoName,
      'license file': info.licenseFile,
      'publisher': info.publisher
                   ? info.publisher
                   :  info.repository ? info.repository.split('/').slice(-2, -1)[0] : _noInfoFound,
      'description': info.description,
      'programming language': 'JavaScript',
      'package version': info.version,
      'publisher contact information': info.email ? info.email : repoName,
      'dependencyType': (packages.filter(pkg => pkg.label === x).length > 0) ? 'immediate' : 'transitive',
    }
  })
  const newPackages = {}

  updatedpackages.forEach(x => {
    const key = `${x['package name']}:${x['package version']}`
    newPackages[key] = x
  })

  const obj = {
    license: {
      path,
      newPackages,
    },
  }
  return obj
}

function writeJsonFile(path, result, packages, isExcelNeeded) {
  const p = new Promise((resolve, reject) => {
    const updatedResult = getExtendedJson(path, result, packages)
    const destinationFolder = path + fileOptions.outputFolderName
    const fullPath = destinationFolder + fileOptions.outputFileName
    fs.outputJson(fullPath, updatedResult, err => {
      if (err) {
        console.log(`Error in writing json files:: ${err}`)
        reject('error in writing the json file')
      }
      if (isExcelNeeded) {
        generateCsvFile(fullPath, updatedResult.license['packages'])
      }
      resolve({destinationFolder, updatedResult})
    })
  })
  return p
}

function generateCsvFile(path, packages) {
  const updatedPath = path.replace('json', 'csv')
  console.log('Start writing npm license csv')
  const fields = ['package name', 'licenses',
                  'download url', 'license file',
                  'publisher', 'description',
                  'programming language', 'package version',
                  'publisher contact information']

  const updatedPackages =  Object.keys(packages).map(x => packages[x])

  const csv = json2csv({ data: updatedPackages, fields })

  fs.writeFile(updatedPath, csv, err => {
    if (err) {
      console.log(`Unable to generate the CSV file due to ${err}`)
      throw err
    }
    console.log(`csv file is created at ${updatedPath}`)
  })
}

function copyLicenseFiles(destinationFolder, updatedResult) {
  const objFiles = {}
  let numCopiedFiles = 0
  let numNoLicenseFiles = 0
  const packages = updatedResult.license.packages
  Object.keys(packages).forEach(x => {
    if (packages[x]['license file'] === _noFileFound) {
      numNoLicenseFiles++
      console.log(`No license file is available for package: ${x}`)
    }
    else {
      numCopiedFiles++
      const key = packages[x]['package name']
      objFiles[key] = packages[x]['license file']
    }
  })
  copy({
    files: objFiles,
    dest: destinationFolder,
  }, err => {
    if (!err) {
      console.log(`All licenses files copied successfully.`)
      console.log(`Total licenses file copied successfully: ${numCopiedFiles} and failed:${numNoLicenseFiles}`)
    }
    else {
      console.log('Error in copying files', err)
    }
  })
}

function getDependencies(pDependencies, pDevDependencies) {
  const dependencies =  Object.keys(pDependencies).map(x => {
    const label = pDependencies[x].indexOf('^') >= 0 ?  pDependencies[x].slice(1) : pDependencies[x]
    return {
      name: x,
      version: pDependencies[x],
      label: `${x}@${label}`,
      type: 'dependency',
    }
  })
  const devDependencies =  Object.keys(pDevDependencies).map(x => {
    const label = pDevDependencies[x].indexOf('^') >= 0 ?  pDevDependencies[x].slice(1) : pDevDependencies[x]
    return {
      name: x,
      version: pDevDependencies[x],
      label: `${x}@${label}`,
      type: 'devDependency',
    }
  })
  return dependencies.concat(devDependencies)
}

function readModulePackageJson(path) {
  const allPackages =  new Promise((resolve, reject) => {
    const packageData = fs.readJsonSync(`${path}/package.json`, {throws: false})
    if (packageData !== undefined) {
      const allDependencies = getDependencies(packageData.dependencies, packageData.devDependencies)
      resolve(allDependencies)
    }
    reject({error: 'Not able to read the package file'})
  })
  return allPackages
}

export function findLicensesInfo(parameter): void {
  console.log('in the license tracker', parameter)
  const  path = parameter.path
  const isExcelNeeded = parameter.isExcel
  options.start = path
  readModulePackageJson(path).then(packages => {
    licenseFinder(path).then(result => {
      writeJsonFile(path, result, packages, isExcelNeeded).then(x => {
        console.log(`JSON file is created`)
        copyLicenseFiles(x['destinationFolder'], x['updatedResult'])
      })
    })
  })
}
