import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Written by scripts/write-build-info.mjs next to the compiled cli.js. */
const BuildInfo = z.object({ sha: z.string().min(1), builtAt: z.iso.datetime() });
export type BuildInfo = z.infer<typeof BuildInfo>;

/** dist/build-info.json beside this module; absent when running from src (tsx). */
export const BUILD_INFO_PATH = join(dirname(fileURLToPath(import.meta.url)), 'build-info.json');

export function readBuildInfo(file: string = BUILD_INFO_PATH): BuildInfo | undefined {
  try {
    return BuildInfo.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Read once per process: the build a process runs never changes under it. */
let cached: BuildInfo | undefined | null = null;
export function runningBuild(): BuildInfo | undefined {
  if (cached === null) cached = readBuildInfo();
  return cached;
}

/**
 * The build on disk is newer than the one answering /healthz: a merge was
 * built but never reloaded (2026-10-06: the risk veto stayed off for a day).
 * A rebuild of the same commit counts too, past 1 s of clock slack. `running`
 * is what /healthz reports: nulls when that router runs from src.
 */
export function isStaleBuild(
  onDisk: BuildInfo | undefined,
  running: { readonly sha: string | null; readonly builtAt: string | null } | undefined,
): boolean {
  if (!onDisk || !running?.sha || !running.builtAt) return false;
  if (onDisk.sha !== running.sha) return true;
  return Date.parse(onDisk.builtAt) - Date.parse(running.builtAt) > 1_000;
}
