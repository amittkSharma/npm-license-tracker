# How the results were verified

A license report is only useful if you can trust it. This page explains what was checked, how, and what the checks
found. Nothing here depends on the tool grading itself: every check compares the tool's output with something
else.

## What was tested

| Project | Size | Package manager |
| --- | --- | --- |
| This repository | 261 packages | npm |
| A real service (a work project, so not named here) | 1,470 packages | npm |
| A tooling project with webpack, jest, eslint, vite and babel | about 590 packages | npm, Yarn classic, Yarn Berry (both linkers) and pnpm |

Every command-line option was run against the first two: each report format, `--production`, `--excludePrivatePackages`,
`--excludePackages`, `--clarificationsFile`, `--failOn`, `--onlyAllow`, `--allowIncomplete`, `--outputDir`, and all of them together.

## The checks, and what they are compared with

| Question | Compared with | Result |
| --- | --- | --- |
| Does the report list exactly the installed packages? | A separate walk of the `node_modules` folder | Identical on both projects (261 and 1,470) |
| Are "direct" dependencies right? | The project's `package.json` | Identical (13 of 13, 39 of 39) |
| Are the licenses right? | The `license` field in `package-lock.json` | 1,877 compared, 0 differences |
| Does `--production` leave out the right packages? | `npm ls --omit=dev --all` | Identical (80 and 545 packages) |
| Do all five formats say the same thing? | Each other, for every package and field | 0 differences in 1,731 packages |
| Is every license file copied correctly? | The original files, byte for byte | 1,675 of 1,675 identical |
| Does `--clarificationsFile` change only what it should? | The file's contents | Yes |
| Is `--failOn` right? | A search for GPL in the report | Exit code matches |
| Is `--onlyAllow` right? | A separate, simpler rule (see below) | Same packages flagged |
| Did a healthy install trigger a false "incomplete" warning? | Expected: none | None |

The `--onlyAllow MIT` check also caught something worth knowing: a package licensed `MIT AND CC-BY-3.0` is
**flagged**, because `AND` means both licenses apply. That is correct, and it is a classic place for
mistakes (treating `AND` like `OR`), so the tests cover it explicitly.

The scan also ran with the scanned project left exactly as it was: no files were created or changed in it.

## Package managers

For each of npm, Yarn classic, Yarn Berry (`node_modules` and Plug'n'Play) and pnpm, the package list was compared
with what is actually installed on disk (for Plug'n'Play, with the packages Yarn's own registry lists whose archives
exist). All five matched exactly on the large project (564, 568, 588, 564 and 588 packages), with the same 14 direct
dependencies, and the license data matched npm's for every package they had in common.

## Odd and broken inputs

A separate run threw 90 awkward projects at the command line: broken or empty `package.json`, wrong value types,
circular dependencies, symlink loops, binary and 6 MB license files, 2 MB descriptions, unprintable characters,
odd project names, unreadable folders, read-only projects, and unusual option values. The expectation for each is
a result or a clear `Error:` message, never a crash or a stack trace.

The first run found three real problems, all fixed and covered by tests:

1. A `package.json` that held a bare string or number crashed inside a library.
2. A project with no dependencies and a name npm rejects (such as `"My App"`) failed with an unhelpful message.
3. A very long project name made an invalid folder name.

## Why the checks are not circular

The tests also include "sabotage" runs: the code is broken on purpose in dozens of ways (for example, treating `AND`
like `OR`, or dropping a package manager's version) and the test suite must notice every time. Several of the real
bugs in the package-manager support were found this way, or by comparing with the disk on large projects, for
example optional platform-specific binaries that were skipped, and a package Yarn marks as `SOFT` that was lost.

## What was not verified

- Windows and Linux (the code uses Node's path handling, but it has not been run there).
- Bun, and Yarn's `pnpm` linker.
- Workspaces scanned from inside a single member folder.
- A live Azure DevOps pipeline (the JUnit file is valid against the standard JUnit schema).
- The HTML report in browsers other than Chrome.
