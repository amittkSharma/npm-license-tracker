# Migrating from 3.x to 4.0

4.0 keeps the command line, the `run()` import path and the module format (CommonJS) unchanged. What
changes is the **content** of the report and a few edge behaviours, all of which were bugs or
inconsistencies in 3.x. Nothing needs to be rewritten for a typical `npm-tracker --path …` user, but
anything that parses the output should be reviewed.

## Quick checklist

- [ ] Using the CLI in CI? It now exits `1` on failure. Make sure that is what you want.
- [ ] Reading `npm_licenses.json` / `.csv`? Check the report changes below.
- [ ] Filtering on `dependencyType === 'immediate'`? The value is now `direct`.
- [ ] Reading the output from a fixed path such as `npm_licenses/npm_licenses.json`? Every run now writes to a new
      `npm_licenses/<package>_<datetime>/` folder (see below); use the `Output folder:` line or `run()`'s result.
- [ ] Reading license files from `npm_licenses/<name>`? They are now in `<run folder>/licenses/<name>@<version>`.
- [ ] Running the tool before installing dependencies, or on pnpm? It now stops with an error (exit `1`) instead of
      writing an empty or partial report; install first, or pass `--allowIncomplete`.
- [ ] Calling `run()` from code? It now rejects on failure and when `path` is missing.
- [ ] Running on Node older than 20? Upgrade (4.0 requires Node 20 or later).
- [ ] Want to enforce licenses in CI? See the new `--failOn` / `--onlyAllow` below (optional).

## Changes

### Report content (JSON and CSV)

| What                     | 3.x                                              | 4.0                                                                  |
| ------------------------ | ------------------------------------------------ | -------------------------------------------------------------------- |
| Missing values           | `<<Default Publisher>>`, `<<Default Email>>`, `<<Default Description>>`, ... | `No information found`; `publisher` falls back to the repository owner and the contact to the repository URL |
| Publisher / email        | Real `author` data was overwritten by the placeholders | Real `author.name` / `author.email` are reported                  |
| Project itself           | Listed as a package (with no license file)       | Not listed                                                           |
| `dependencyType`         | `immediate` or `transitive`; matched `name@version` to the declared range, only `^` worked, others showed `transitive` | **`direct`** or `transitive`; decided by install location, correct for any range style, aliases and symlinked installs |
| `licenses`               | A string, or an array for multi-license packages | Always a string; several licenses read `MIT OR ISC`                  |
| CSV columns              | 9 columns, no `dependencyType`                   | 10 columns: the same properties as the JSON, same order, `dependencyType` last |
| JSON formatting          | Failed to write on current `fs-extra`            | 2-space indented                                                     |

### One output folder per run

3.x wrote everything into `npm_licenses/`, so each run overwrote the last. 4.0 creates a **new folder for every run**:
`npm_licenses/<package name>_<YYYY-MM-DD_HH-mm-ss>/` (local time; `@acme/tool` becomes `@acme-tool`). Nothing is
overwritten, and two runs in the same second get `-2`, `-3`, … suffixes.

- **Find it:** the CLI prints `Output folder: <path>`, and `run()` resolves with `{ outputFolder }` (a
  `LicensePolicyError` carries `outputFolder` too).
- **CI:** publish the parent folder (`npm_licenses`) or use a glob such as `**/npm_licenses.junit.xml`; on a
  persistent agent, clean old runs first because they are never deleted.
- **Scripts:** replace `npm_licenses/npm_licenses.json` with a lookup of the newest folder under `npm_licenses/`
  (the names sort by time), or use the result of `run()`.

### License files

3.x copied `npm_licenses/<name>`, so two versions of one package overwrote each other.
4.0 always writes `<run folder>/licenses/<name>@<version>`, for example `lodash@4.17.21` and `@babel-core@7.24.0`
(`/` in scoped names is still replaced by `-`). Update any script that looked files up by plain name.

The license files now live in their own `licenses/` sub-folder; the reports (`npm_licenses.json`, `.csv`, ...) stay at the
top of the run folder. Files that 3.x left directly in `npm_licenses/` are not removed, so delete them once.

The console summary now counts files actually copied.

### Programmatic API

```js
const { run } = require('npm-license-tracker/src'); // unchanged
```

- `run()` returns a promise. It **resolves** when everything is written and **rejects** on any failure
  (unreadable `package.json`, scan error, write error, copy error) and when `path` is missing.
  In 3.x failures surfaced as unhandled rejections or console messages only.
- Await it, or add `.catch`: an ignored rejection ends the Node process.
- Types are now included (`RunOptions`).

### Command line

Options are unchanged (`--path`, `--isExcel`, `--help`). New: failures print `Error: <reason>` to stderr and
the exit code is `1`; success is still `0`. Projects without `devDependencies` no longer crash, and a CSV
path containing the text `json` elsewhere in it is no longer mangled.

### Package internals

- Written in TypeScript; the published package is the compiled `dist/`.
- `exports` keeps `npm-license-tracker`, `npm-license-tracker/src`, `/src/index` and `/src/index.js`
  working. Other deep imports (for example `npm-license-tracker/src/npm-license-tracker`) are no longer exposed.
- The unused `read-package-json` dependency was removed; dependencies were updated (no known vulnerabilities).
- License scanning moved from the unmaintained `license-checker` (last release 2019) to its maintained fork
  `license-checker-rseidelsohn` (pinned 4.4.2). On this project's own 240-package tree both return identical
  packages and fields. The fork is ESM-only; it is loaded with a dynamic `import()`, so the package itself
  is still CommonJS and works on Node 20.0 and later.

## Package managers and the package manager in reports (new in 4.0)

- **pnpm (default layout), Yarn Berry Plug'n'Play, Yarn classic and Yarn Berry with `node_modules` are all read
  natively.** In 3.x only a flat `node_modules` worked, and a pnpm project silently produced a report with most
  packages missing. No package-manager setting needs to change.
- **Every report records the package manager and its version** (an exact version when recorded, otherwise a hint such
  as `Yarn 4.x (Berry)`): JSON `license.packageManager`, the HTML header, a Markdown summary line, JUnit suite
  properties, and **two extra CSV columns** (`package manager`, `package manager version`). If you read the CSV by
  position, the first ten columns are unchanged.
- For a Plug'n'Play project, the `license file` shows Yarn's archive path (`….zip/node_modules/<name>/LICENSE`).
- In the CSV, a cell that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet can't run it as a formula
  (a package description is written by whoever published the package).
- `direct` now also covers the project's own `optionalDependencies` and `peerDependencies`.

## New in 4.0 (all optional, defaults unchanged)

| CLI                          | API (`run()` option)        | What it does                                          |
| ---------------------------- | --------------------------- | ----------------------------------------------------- |
| `--production`               | `production`                | Skip devDependencies                                  |
| `--excludePrivatePackages`   | `excludePrivatePackages`    | Skip `"private": true` packages                       |
| `--excludePackages "a;b@2"`  | `excludePackages: ['a','b@2']` | Skip by name, `name@major` or `name@version`       |
| `--clarificationsFile f.json`| `clarificationsFile`        | Supply licenses the scanner cannot detect             |
| `--failOn "GPL-3.0"`         | `failOn: ['GPL-3.0']`       | Fail if a package has any listed license              |
| `--outputDir <folder>`       | `outputDir`                 | Write the results somewhere else; nothing is written inside the scanned project |
| `--isHtml`                   | `isHtml: true`              | Also write a self-contained `npm_licenses.html` report |
| `--isJunit`                  | `isJunit: true`             | Also write `npm_licenses.junit.xml` for Azure DevOps and other CI |
| `--isMarkdown`               | `isMarkdown: true`          | Also write `npm_licenses.md` |
| `--format all` / `--format html,csv` | `formats: 'all'` / `['html','csv']` | Choose reports by name; `all` = every report. Combines with the `--isXxx` options, which keep working |
| `--onlyAllow "MIT;ISC"`      | `onlyAllow: ['MIT','ISC']`  | Fail if a package has none of the listed licenses     |

The policy options fail the run **after** the report is written (exit code `1`; the API rejects with a
`LicensePolicyError` whose `violations` lists `{ package, licenses, rule }`). Details are in the README.

## Release note (copy for the changelog)

> **BREAKING:** report fields use `No information found` instead of `<<Default …>>`; the scanned project is
> no longer listed; `dependencyType` is computed from install location; `licenses` is always a string; the
> CSV gains a `dependencyType` column and `immediate` is now called `direct`; license files are named `<name>@<version>` and moved into an `npm_licenses/licenses/` sub-folder (reports stay in `npm_licenses/`); `run()` rejects on failure
> and without a `path`; every run writes to a new `npm_licenses/<package>_<datetime>/` folder, which `run()` returns as `outputFolder`; the CLI exits `1` on failure; Node 20+ required; license scanning now uses the maintained
> `license-checker-rseidelsohn`.
>
> **Features:** `--production`, `--excludePrivatePackages`, `--excludePackages`, `--clarificationsFile`,
> `--failOn`, `--onlyAllow`, and HTML, JUnit and Markdown reports (`--isHtml`, `--isJunit`, `--isMarkdown`, or `--format all`), with the matching `run()` options.
