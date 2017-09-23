'use strict'

module.exports = {
  NoProperArguments:(path) => {
    return `module stopped working: ${path}`
  },

  ErrorInWritingFile:(path) => {
    return `not able to write the file: ${path}`
  },

  ErrorInReadingNpmPackages:(path, err) => {
    return `fail to read npm packages at: ${path} and error is: ${err}`
  }
}
