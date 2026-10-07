import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isStaleBuild, readBuildInfo } from '../src/build-info.js';

const built = { sha: 'abc123def456', builtAt: '2026-10-07T10:00:00.000Z' };

describe('isStaleBuild', () => {
  it('is fresh when the running build is the one on disk', () => {
    assert.equal(isStaleBuild(built, built), false);
  });

  it('is stale when the sha on disk differs from the running one', () => {
    assert.equal(isStaleBuild({ ...built, sha: 'fff000fff000' }, built), true);
  });

  it('is stale when the same commit was rebuilt more than a second later', () => {
    assert.equal(isStaleBuild({ ...built, builtAt: '2026-10-07T10:00:01.000Z' }, built), false, 'one second is clock noise');
    assert.equal(isStaleBuild({ ...built, builtAt: '2026-10-07T10:00:01.001Z' }, built), true);
  });

  it('cannot tell without both sides', () => {
    assert.equal(isStaleBuild(undefined, built), false);
    assert.equal(isStaleBuild(built, undefined), false);
    assert.equal(isStaleBuild(built, { sha: null, builtAt: null }), false, 'a router running from src has no build info');
  });
});

describe('readBuildInfo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-build-info-'));

  it('reads the file the build writes', () => {
    const file = join(dir, 'ok.json');
    writeFileSync(file, `${JSON.stringify(built)}\r\n`);
    assert.deepEqual(readBuildInfo(file), built);
  });

  it('gives up on a missing or malformed file instead of throwing', () => {
    assert.equal(readBuildInfo(join(dir, 'missing.json')), undefined);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"sha":');
    assert.equal(readBuildInfo(bad), undefined);
    writeFileSync(bad, '{"sha":"x"}');
    assert.equal(readBuildInfo(bad), undefined);
  });
});
