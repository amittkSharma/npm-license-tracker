import { unzipSync } from 'fflate';
import fs from 'fs-extra';

/**
 * Yarn Plug'n'Play keeps packages in zip archives and addresses a file inside one as
 * `<archive>.zip/<path inside>` (a "virtual" path). Splits such a path; undefined for a normal path.
 */
export function splitZipPath(path: string): { zip: string; inner: string } | undefined {
  const match = path.match(/^(.*?\.zip)[\\/](.*)$/);
  return match ? { zip: match[1], inner: match[2].replace(/\\/g, '/') } : undefined;
}

/** Reads only the entries of `zip` accepted by `wanted` (others are not decompressed). */
export function readZipEntries(
  zip: string,
  wanted: (name: string) => boolean,
): Record<string, Uint8Array> {
  return unzipSync(fs.readFileSync(zip), { filter: (file) => wanted(file.name) });
}

/** The bytes of a file addressed by a virtual path, or undefined when it is not inside the archive. */
export function readVirtualFile(path: string): Uint8Array | undefined {
  const parts = splitZipPath(path);
  if (!parts || !fs.existsSync(parts.zip)) return undefined;
  return readZipEntries(parts.zip, (name) => name === parts.inner)[parts.inner];
}
