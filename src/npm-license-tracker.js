var licenseChecker = require('license-checker');
const fs = require('fs-extra');
const copy = require('copy-files');
const colors = require('colors');
const json2csv = require('json2csv');

const _noInfoFound = 'No information found'
const _noFileFound = 'none'
var options = {
  json: true,
  production : true,
  start: '',
  customFormat: {
    "name": "",
    "version": "",
    "description": "",
    "licenses": "",
    "publisher": "",
    "email":"",
    "licenseFile": "none",
    "licenseModified": "no"
  }
}

const fileOptions = {
  outputFolderName: '/npm_licenses/',
  outputFileName: 'npm_licenses.json'
}


licenseFinder = function (path) {
  const p =  new Promise((resolve, reject) => {
    licenseChecker.init(options, (licenseMap, err)=> {
      if (err) {
        reject('error occured in reading npm packages', err);
      }
      resolve(licenseMap)
    });
  })
  return p
}

getExtendedJson = function(path, json) {
  var updatedpackages = Object.keys(json).map(x => {
    var info = json[x]
    var repoName = info.repository ? info.repository.replace('git+', '') : _noInfoFound
    return {
      'package name': info.name,
      'licenses': info.licenses,
      'download url': repoName,
      'license file': info.licenseFile,
      'publisher': info.publisher ? info.publisher :  info.repository ? info.repository.split("/").slice(-2, -1)[0] : _noInfoFound,
      'description': info.description,
      'programming language': 'JavaScript',
      'package version': info.version,
      'publisher contact information': info.email ? info.email : repoName,
    }
  })
  var packages = {}

  updatedpackages.forEach(x => {
    var key = x['package name'] + ':' + x['package version']
    packages[key] = x
  })

  var obj = {
    license: {
      path,
      packages,
    }
  }
  return obj
}

writeJsonFile = function(path, result, isExcelNeeded) {
  const p = new Promise((resolve, reject) => {
    const updatedResult = getExtendedJson(path, result)
    const destinationFolder = path + fileOptions.outputFolderName
    const fullPath = destinationFolder + fileOptions.outputFileName
    fs.outputJson(fullPath, updatedResult, (err) => {
      if (err) {
        console.log('Error in writing json files::'.red + err);
        reject('error in writing the json file');
      }
      if (isExcelNeeded) {
        generateCsvFile(fullPath, updatedResult.license.packages)
      }
      resolve({destinationFolder, updatedResult})
    });
  })
  return p
}

generateCsvFile = function (path, packages) {
  const updatedPath = path.replace("json", "csv");
  console.log('Start writing npm license csv'.yellow)
  const fields = ['package name', 'licenses', 'download url', 'license file', 'publisher', 'description', 'programming language', 'package version', 'publisher contact information']

  const updatedPackages =  Object.keys(packages).map(x => packages[x])

  const csv = json2csv({ data:updatedPackages, fields: fields });

  fs.writeFile(updatedPath, csv, function (err) {
    if (err) {
      console.log('hello world', err)
      throw err;
    }
    console.log('csv file is created at'.green, updatedPath);
  });
}

copyLicenseFiles = function(destinationFolder, updatedResult) {
  let objFiles = {};
  let numCopiedFiles = 0;
  let numNoLicenseFiles = 0;
  const packages = updatedResult.license.packages
  Object.keys(packages).forEach(x => {
    if (packages[x]['license file'] === _noFileFound) {
      numNoLicenseFiles++;
      console.log('No license file is available for package:'.red, x);
    }
    else {
      numCopiedFiles++;
      var key = packages[x]['package name']
      objFiles[key] = packages[x]['license file']
    }
  })
  copy({
    files: objFiles,
    dest: destinationFolder
  }, function (err) {
    if (!err) {
      console.log('All licenses files copied successfully.'.green);
      console.log('Total licenses file copied successfully:'.green, numCopiedFiles);
      console.log('Total licenses copied fail:'.green, numNoLicenseFiles);
    }
    else {
      console.log('Error in copying files', err)
    }
  })
}

module.exports = {
  findLicensesInfo: function (parameter) {
    var path = parameter.path;
    var isExcelNeeded = parameter.isExcel;
    options.start = path
    licenseFinder(path).then(result => {
      writeJsonFile(path, result, isExcelNeeded).then(x => {
        console.log('JSON file is created'.green)
        copyLicenseFiles(x.destinationFolder, x.updatedResult)
      })
    })
  }
}