// Stamps dist/build-info.json so /healthz and the status line can tell which build is running.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let sha = 'unknown';
try {
  sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // Not a git checkout (npm tarball): the timestamp still tells builds apart.
}
writeFileSync(join('dist', 'build-info.json'), `${JSON.stringify({ sha, builtAt: new Date().toISOString() })}\n`);
