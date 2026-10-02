export const NoProperArguments = (path: string): string => `module stopped working: ${path}`;

export const ErrorInWritingFile = (path: string): string => `not able to write the file: ${path}`;

export const ErrorInReadingNpmPackages = (path: string, err: unknown): string =>
  `fail to read npm packages at: ${path} and error is: ${err}`;
