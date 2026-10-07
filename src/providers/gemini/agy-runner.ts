import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface AgyRunnerOptions {
  readonly bin: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly home: string;
  readonly signal?: AbortSignal;
}

export type AgyResult =
  | { readonly ok: true; readonly text: string; readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }
  | { readonly ok: false; readonly reason: string };

export type SpawnAgy = (bin: string, args: string[], options: any) => ChildProcess;

export async function runAgy(
  prompt: string,
  opts: AgyRunnerOptions,
  spawnFn: SpawnAgy = spawn
): Promise<AgyResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'agy-'));
  
  try {
    const printTimeout = Math.ceil(opts.timeoutMs / 1000) + 5;
    const args = [
      '--model', opts.model,
      '--disable-slash-commands',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--print-timeout', `${printTimeout}s`,
      '--print='
    ];

    const child = spawnFn(opts.bin, args, {
      cwd,
      env: { ...process.env, USERPROFILE: opts.home, HOME: opts.home },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timeout = setTimeout(() => {
      killTree(child.pid!);
    }, opts.timeoutMs);

    const abortHandler = () => {
      killTree(child.pid!);
    };
    opts.signal?.addEventListener('abort', abortHandler);

    const cleanup = () => {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', abortHandler);
    };

    child.stdin!.write(JSON.stringify({
      event: 'user',
      message: { role: 'user', content: prompt }
    }) + '\n');
    child.stdin!.end();

    let stdoutBuffer = '';
    let textDelta = '';
    let finalResult: any = undefined;
    let toolAttempted = false;

    child.stdout!.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'step_update' && ev.step_update) {
            if (ev.step_update.step_type === 'tool') {
              toolAttempted = ev.step_update.tool_name;
              killTree(child.pid!);
            } else if (ev.step_update.step_type === 'agent_response' && ev.step_update.text_delta) {
              textDelta += ev.step_update.text_delta;
            }
          } else if (ev.event === 'result' && ev.result) {
            finalResult = ev.result;
          }
        } catch {}
      }
    });

    return await new Promise<AgyResult>((resolve) => {
      child.on('error', (err) => {
        cleanup();
        resolve({ ok: false, reason: err.message });
      });

      child.on('close', (code) => {
        cleanup();
        
        // Ensure remaining buffer is parsed
        if (stdoutBuffer.trim()) {
           try {
              const ev = JSON.parse(stdoutBuffer);
              if (ev.event === 'result' && ev.result) finalResult = ev.result;
           } catch {}
        }

        if (toolAttempted) {
          return resolve({ ok: false, reason: `tool attempt: ${toolAttempted}` });
        }
        if (opts.signal?.aborted) {
          return resolve({ ok: false, reason: 'aborted' });
        }
        if (code !== 0) {
          if (finalResult && finalResult.status === 'ERROR') {
             return resolve({ ok: false, reason: finalResult.error || `exit ${code}` });
          }
          return resolve({ ok: false, reason: `exit ${code}` });
        }
        
        if (!finalResult) {
          return resolve({ ok: false, reason: 'no result event' });
        }
        if (finalResult.status !== 'SUCCESS') {
          return resolve({ ok: false, reason: finalResult.error || 'status not SUCCESS' });
        }
        
        const responseText = (finalResult.response || textDelta).trim();
        if (!responseText) {
          return resolve({ ok: false, reason: 'empty response' });
        }
        
        resolve({
          ok: true,
          text: finalResult.response || textDelta,
          usage: {
            inputTokens: finalResult.usage?.input_tokens ?? 0,
            outputTokens: finalResult.usage?.output_tokens ?? 0
          }
        });
      });
    });
  } finally {
    try { await rm(cwd, { recursive: true, force: true }); } catch {}
    try { await rm(join(opts.home, '.gemini', 'antigravity-cli', 'brain'), { recursive: true, force: true }); } catch {}
    try { await rm(join(opts.home, '.gemini', 'antigravity-cli', 'annotations'), { recursive: true, force: true }); } catch {}
  }
}

function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', pid.toString(), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
