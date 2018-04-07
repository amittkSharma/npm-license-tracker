class Exceptions {

  NoProperArguments(path: string): string {
    return `module stopped working: ${path}`
  }

  ErrorInWritingFile(path: string): string {
    return `not able to write the file: ${path}`
  }

  ErrorInReadingNpmPackages(path, err): string {
    return `fail to read npm packages at: ${path} and error is: ${err}`
  }
}

export const exceptions = new Exceptions()
