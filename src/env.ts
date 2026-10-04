import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jevHome } from './paths.js';

/**
 * Loads one env file: explicit path > ./.env > ~/.jev-router/.env.
 * Variables already set in the shell win (process.loadEnvFile never overwrites).
 * Returns the file loaded, if any.
 */
export function loadEnv(explicit?: string): string | undefined {
  if (explicit) {
    const file = resolve(explicit);
    if (!existsSync(file)) throw new Error(`env file not found: ${file}`);
    process.loadEnvFile(file);
    return file;
  }
  for (const file of [resolve('.env'), join(jevHome(), '.env')]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return undefined;
}
