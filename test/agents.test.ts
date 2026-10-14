import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { recordAgentEvent, runningAgents, STALE_SESSION_MS } from '../src/agents.js';

describe('agents', () => {
  it('forgets the subagents of a resumed session: they died with the process that ran them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-agents-'));
    recordAgentEvent({ hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a1' }, dir);
    recordAgentEvent({ hook_event_name: 'SessionStart', session_id: 's', source: 'compact' }, dir);
    assert.equal(runningAgents('s', dir)?.count, 1, 'compaction keeps agents running');
    recordAgentEvent({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' }, dir);
    assert.equal(runningAgents('s', dir), undefined);
  });

  it('sweeps session folders untouched for a week on any SessionStart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-agents-'));
    const now = Date.now();
    for (const s of ['dead', 'alive']) recordAgentEvent({ hook_event_name: 'SubagentStart', session_id: s, agent_id: 'a1' }, dir);
    const old = (now - STALE_SESSION_MS - 60_000) / 1000;
    utimesSync(join(dir, 'dead'), old, old);
    recordAgentEvent({ hook_event_name: 'SessionStart', session_id: 'new', source: 'startup' }, dir, now);
    assert.equal(existsSync(join(dir, 'dead')), false);
    assert.equal(runningAgents('alive', dir)?.count, 1);
  });

  it('agent-hook waits for a slow stdin and always exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jev-agents-cli-'));
    const envFile = join(home, 'empty.env');
    writeFileSync(envFile, '', 'utf8');
    const run = (payload: string, delayMs: number) =>
      new Promise<number | null>((done) => {
        const proc = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), 'agent-hook', '--env', envFile], {
          env: { ...process.env, JEV_ROUTER_HOME: home },
        });
        proc.on('close', done);
        // Past the status line's 300 ms bound: a hook must not drop a late SubagentStop.
        setTimeout(() => proc.stdin.end(payload), delayMs);
      });
    assert.equal(await run(JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a1' }), 800), 0);
    assert.equal(runningAgents('s', join(home, 'agents'))?.count, 1);
    assert.equal(await run('not json', 0), 0);
  });
});
