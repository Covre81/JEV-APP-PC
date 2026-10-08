import { statSync, existsSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import * as os from 'node:os';

const MARKERS = ['.git', '.ai-memory.toml', 'graphify-out', 'package.json', 'CLAUDE.md'];

export function isProjectDir(cwd: string, home: string = os.homedir()): boolean {
  let current: string;
  let homeResolved: string;
  try {
    current = resolve(cwd);
    homeResolved = resolve(home);
  } catch {
    return false;
  }

  const comparePath = (a: string, b: string) => {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  };

  try {
    const stat = statSync(current);
    if (!stat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  while (true) {
    if (comparePath(current, homeResolved)) {
      return false;
    }

    const { root } = parse(current);
    if (comparePath(current, root)) {
      return false;
    }

    for (const marker of MARKERS) {
      if (existsSync(resolve(current, marker))) {
        return true;
      }
    }

    const parent = dirname(current);
    if (comparePath(parent, current)) {
      return false;
    }
    current = parent;
  }
}
