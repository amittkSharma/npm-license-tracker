# Publishing

How a release gets from source to the npm registry, and what each script does along the way.
This file lives in `docs/` (see the [docs index](README.md)), which is excluded from the published package (`.npmignore`).

## Why there is a build step

The source is TypeScript (`src/`, `bin/`). npm consumers get the compiled JavaScript in `dist/`.
`dist/` is **not committed** (it is in `.gitignore`); it is produced by the scripts below and
shipped because `.npmignore` takes precedence over `.gitignore` at publish time.

What ships: `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.
What does not: `src/`, `bin/`, `test/`, `docs/`, configs, images (see `.npmignore`).

## Scripts

| Script                  | What it does                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- |
| `npm run build`         | Compiles `src/` and `bin/` to `dist/` with `tsc`                             |
| `npm run clean`         | Deletes `dist/` (Node `fs.rmSync`, works on Windows, macOS and Linux)        |
| `npm run lint`          | Biome checks (`lint:fix` applies fixes)                                      |
| `npm run typecheck`     | Type-checks sources and tests without emitting                               |
| `npm test`              | Unit and end-to-end tests, run against the TypeScript sources                |
| `npm run test:dist`     | Smoke test of the **built** package (see below)                              |
| `npm run prepare`       | Runs `build`. npm calls it automatically (see below)                         |
| `npm run prepublishOnly`| `clean` → `build` → `test` → `test:dist`. npm calls it before `npm publish`  |
| `npm run release`       | Bumps the version, updates `CHANGELOG.md`, commits and tags (`commit-and-tag-version`). Does **not** publish |

## Lifecycle hooks

### `prepare`: builds `dist/` automatically
npm runs `prepare` on a local `npm install` (no arguments) and when the package is installed from a
git URL (for example `npm i github:amittkSharma/npm-license-tracker`). Without it, those installs
would have no `dist/` and `main`/`bin` would point at nothing.

### `prepublishOnly`: the publish gate
Runs only on `npm publish`, before the tarball is created. It starts from a clean `dist/`, so a stale
build can never be published, and aborts the publish if any step fails:

1. `npm run clean`: remove old output
2. `npm run build`: compile
3. `npm test`: behaviour tests (against sources)
4. `npm run test:dist`: smoke test of the compiled output

### What `test:dist` covers
The regular tests import the TypeScript sources, so they cannot notice a broken package layout.
`test/dist.smoke.ts` loads the built package the way a consumer does:

- `main`, `types` and `bin` in `package.json` point at files that exist, and the bin has a shebang
- every `exports` entry (`.`, `./src`, `./src/index`, `./src/index.js`) resolves and exposes `run()`
- the compiled CLI writes the report, and exits `1` on failure

It needs a built `dist/`, so run `npm run build` first (or just run `npm run prepublishOnly`).

## Release checklist

1. Work on a branch and merge to `master` once the checks pass. CI (`.github/workflows/ci.yml`) runs lint, typecheck, build,
   tests and `npm audit` on Ubuntu and macOS with Node 20, 22 and 24. The Windows job is allowed to fail for now: read its
   output, because it is the only place Windows is exercised. Locally: `npm run lint && npm run typecheck && npm test`.
2. On `master`, create the release commit and tag (Conventional Commits drive the version):
   ```sh
   npm run release            # or: npm run release -- --release-as major   (e.g. for 4.0.0)
   git push --follow-tags origin master
   ```
3. Rehearse the publish. This runs `prepublishOnly` and lists exactly what would ship, without uploading:
   ```sh
   npm publish --dry-run
   ```
   Check that the file list contains only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.
4. Optionally test the real tarball in a scratch project:
   ```sh
   npm pack
   mkdir /tmp/try && cd /tmp/try && npm init -y && npm i /path/to/npm-license-tracker-<version>.tgz
   npx npm-tracker --path /path/to/some/project
   ```
5. Publish:
   ```sh
   npm login
   npm publish
   ```

## Troubleshooting

- **`dist/` is missing after cloning**: run `npm install` (triggers `prepare`) or `npm run build`.
- **`test:dist` fails with "is missing"**: you have not built yet. Run `npm run build`.
- **A file is missing from the tarball**: check `.npmignore`, then `npm pack --dry-run`.
- **Need to publish without the gate**: don't. Fix the failing step; `--ignore-scripts` would also skip the build and ship an empty package.
