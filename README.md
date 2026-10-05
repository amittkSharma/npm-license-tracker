# npm-license-tracker

[![npm version](https://img.shields.io/npm/v/npm-license-tracker.svg)](https://www.npmjs.com/package/npm-license-tracker)
[![npm downloads](https://img.shields.io/npm/dm/npm-license-tracker.svg)](https://www.npmjs.com/package/npm-license-tracker)
[![license](https://img.shields.io/npm/l/npm-license-tracker.svg)](LICENSE)

**See every license in your dependency tree with one command.**

Point it at a project and it writes a report (JSON, CSV, HTML, Markdown or JUnit) plus a copy of every license
file. It works with **npm, Yarn and pnpm**, runs offline, and never changes your project.

> **Upgrading from 3.x?** Read the [migration guide](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/migration-3-to-4.md) first. Some report details and file locations changed.

## Quick start

Install your dependencies as usual, then run this in your project folder:

```sh
npx npm-license-tracker --path . --format all
```

You will see something like this:

```
Output folder: /your/project/npm_licenses/my-app_2026-10-02_09-30-00
csv file is created at .../npm_licenses.csv
html file is created at .../npm_licenses.html
...
Total licenses file copied successfully: 259 and failed:1
```

Open `npm_licenses.html` in your browser. That's it.

```
npm_licenses/
└── my-app_2026-10-02_09-30-00/      one new folder for every run
    ├── npm_licenses.json            the full report
    ├── npm_licenses.html            searchable, sortable, with a license viewer
    ├── npm_licenses.md              paste into a wiki or pull request
    ├── npm_licenses.csv             open in Excel
    ├── npm_licenses.junit.xml       for CI test results (Azure DevOps and others)
    └── licenses/                    a copy of each package's license file
```

## What can I do with it?

- **Audit:** list every license, find the odd ones (`UNKNOWN`, copyleft) and hand legal an HTML or Excel file.
- **Guard your build:** fail CI when a dependency uses a license you don't allow.
- **Keep evidence:** every run is saved in its own folder, together with the license files themselves.

## Install

Use it without installing:

```sh
npx npm-license-tracker --path .
```

Or install it once:

```sh
npm install -g npm-license-tracker
npm-tracker --path .
```

You need Node.js 20 or newer. Your project's dependencies must already be installed (`npm ci`, `yarn install` or
`pnpm install`). If they are not, you get a clear error, never an empty report that looks fine.

## Recipes

**Only what ships to production** (skip devDependencies):

```sh
npx npm-license-tracker --path . --production --format html,markdown
```

**Fail the build on licenses you don't want:**

```sh
npx npm-license-tracker --path . --production --failOn "GPL-3.0;AGPL-3.0"
```

**Allow only an approved list** (anything else fails):

```sh
npx npm-license-tracker --path . --production --onlyAllow "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0"
```

The report is always written first, so a failing check still leaves the files to look at.

**Keep results out of the project** (read-only checkouts, tidy repos):

```sh
npx npm-license-tracker --path . --outputDir ../license-results --format all
```

**GitHub Actions:**

```yaml
- run: npx npm-license-tracker --path . --production --format html,markdown
- uses: actions/upload-artifact@v4
  with:
    name: license-report
    path: npm_licenses
```

**Azure DevOps** (the JUnit file shows up in the Tests tab):

```yaml
steps:
  - script: npx npm-license-tracker --path "$(Build.SourcesDirectory)" --production --format html,junit --onlyAllow "MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0"
    displayName: License audit

  - task: PublishTestResults@2
    condition: succeededOrFailed()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: '**/npm_licenses.junit.xml'
      testRunTitle: License audit

  - task: PublishPipelineArtifact@1
    condition: succeededOrFailed()
    inputs:
      targetPath: npm_licenses
      artifact: license-report
```

Use `succeededOrFailed()` on the publishing steps: when the policy fails, the first step exits with `1`, and you
still want the report. Publish the whole `npm_licenses` folder, because the HTML report reads the `licenses/` folder
next to it.

## Options

| Option | What it does |
| --- | --- |
| `--path <folder>` | The project to scan (the folder with `package.json`). **Required.** |
| `--format <list>` | Reports to write besides the JSON: `csv`, `html`, `junit`, `markdown`, or `all`. Example: `--format html,csv` |
| `--outputDir <folder>` | Where to put the results. Default: `npm_licenses` inside the project. |
| `--production` | Skip devDependencies and anything only they need. |
| `--failOn <list>` | Exit `1` if a package has one of these licenses, e.g. `"GPL-3.0;AGPL-3.0"`. |
| `--onlyAllow <list>` | Exit `1` unless every package's license is covered by this list. |
| `--excludePrivatePackages` | Leave out packages marked `"private": true`. |
| `--excludePackages <list>` | Leave out packages by full name: `name`, `name@major` or `name@version`, separated by `;`. |
| `--clarificationsFile <file>` | Tell the tool a license it can't detect (see below). |
| `--allowIncomplete` | Write the report even if some dependencies could not be read. |
| `--isExcel`, `--isHtml`, `--isJunit`, `--isMarkdown` | Older spellings of `--format csv`, `html`, `junit` and `markdown`. They still work. |

## Works with your package manager

| Package manager | Supported |
| --- | --- |
| npm | Yes |
| Yarn classic (1.x) | Yes |
| Yarn 2 and newer (Berry), `node_modules` or Plug'n'Play | Yes |
| pnpm, default or `hoisted` | Yes |
| Bun | Not tested |

You don't need to change any setting. The tool works out how your dependencies were installed by reading files
(it never runs a package manager), and every report says which package manager and version it found.

If your project declares `"packageManager": "pnpm@9.15.9"` in `package.json`, that exact version is shown.
pnpm also records its own version. For npm and Yarn without that field you see a hint such as `Yarn 4.x (Berry)`
instead of an exact version, because they don't record one.

## What's in the report?

Every package gets the same ten fields in every format:

```json
"lodash:4.17.21": {
  "package name": "lodash",
  "licenses": "MIT",
  "download url": "https://github.com/lodash/lodash",
  "license file": "/your/project/node_modules/lodash/LICENSE",
  "publisher": "John-David Dalton",
  "description": "Lodash modular utilities.",
  "programming language": "JavaScript",
  "package version": "4.17.21",
  "publisher contact information": "john.david.dalton@gmail.com",
  "dependencyType": "direct"
}
```

- **direct** means your own `package.json` asks for it (in `dependencies`, `devDependencies`, `optionalDependencies` or
  `peerDependencies`). **transitive** means it came in through another package.
- The package manager and its version are stored next to the packages (in the CSV, as two extra columns).
- The HTML report can search, filter and sort, and clicking a license file opens it in a side panel. Keep
  `npm_licenses.html` next to its `licenses/` folder so the panel can find the files.

## Questions

**Does it change my project?** No. It only reads files, and writes its results to one new folder (default
`npm_licenses` inside the project, or wherever `--outputDir` says). Add `npm_licenses/` to your `.gitignore`.

**Does it need internet?** No. The HTML report doesn't load anything from the web either.

**Where are my results?** The tool prints `Output folder: ...`. Every run creates a **new** folder named after the
package and the time, so nothing is overwritten. Old folders are not deleted.

**What do `UNKNOWN`, `*` and "No information found" mean?**
`UNKNOWN` means the package states no license and ships no license file; check it by hand. A `*` (like `BSD*`)
means the text wasn't a standard license name, so the tool made its best guess. "No information found" means the
package doesn't provide that detail.

**Why did it exit with code 1?** One of three reasons, and the message says which:
(1) your `--failOn` / `--onlyAllow` rule matched (the report is still written, so you can look at it), (2) the scan is
incomplete because a dependency isn't installed or can't be read (nothing is written, so you never get a report that
quietly leaves packages out), or (3) something failed, such as a bad path, an unwritable folder or a broken
`package.json`.

**How does `--onlyAllow` treat licenses like `MIT OR Apache-2.0`?** As SPDX expressions. `OR` is a choice, so one
allowed side is enough. `AND` means both apply, so both must be allowed. `--failOn` is stricter: if a banned license
appears anywhere in the expression, it fails.

**How do I fix an `UNKNOWN` license?** Check the package yourself, then tell the tool with a clarifications file:

```json
{ "some-package@1.2.3": { "licenses": "MIT" } }
```

```sh
npx npm-license-tracker --path . --clarificationsFile clarifications.json
```

**Does it work in a monorepo?** Run it in the workspace root (where the main `node_modules`, or `.pnp.cjs`, lives).
Running it from inside a single workspace member is not tested.

**Which systems is it tested on?** macOS, with Node 20 and 22. Linux and Windows should work, because the code uses
Node's own path handling, but they haven't been tested yet.

**Is the CSV safe to open in Excel?** Yes. Package descriptions are written by whoever published the package, and a
spreadsheet would run a cell that starts with `=`, `+`, `-` or `@` as a formula. The tool puts a `'` in front of such
cells so they stay plain text. Ordinary values, including scoped names like `@babel-core`, are not changed.

**Does `--excludePackages` understand scopes?** Not yet. Use full package names (`typescript`, `lodash@4`,
`react@18.2.0`). `@types` will not exclude every `@types/*` package.

**Is the HTML report safe to share?** It is a single file with no web requests. Note that the "license file" column
shows paths from your machine.

**Can I trust the numbers?** See [how the results were verified](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/verification.md):
the package list was compared with what is really installed, the dependencies with `package.json`, and the policy
results with an independent check.

## Use it from code

```js
const { run, LicensePolicyError } = require('npm-license-tracker');

try {
  const { outputFolder } = await run({
    path: '/path/to/project',
    formats: ['html', 'markdown'], // or 'all'
    production: true,
    failOn: ['GPL-3.0'],
  });
  console.log(`Reports are in ${outputFolder}`);
} catch (err) {
  // the reports are written before the policy is enforced, so they exist even now
  if (err instanceof LicensePolicyError) console.error(err.violations, err.outputFolder);
  else throw err;
}
```

`run()` returns a promise. It rejects on any failure, so remember to `await` it or add `.catch()`. TypeScript
types are included, and the older `require('npm-license-tracker/src')` still works.

## More documentation

The [docs folder](https://github.com/amittkSharma/npm-license-tracker/tree/master/docs) has the
[migration guide](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/migration-3-to-4.md), how the
[results were verified](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/verification.md), the
[architecture](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/architecture.md) and the
[publishing guide](https://github.com/amittkSharma/npm-license-tracker/blob/master/docs/publishing.md).

## Contributing

```sh
npm install
npm run build       # compile to dist/
npm run lint        # Biome
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
