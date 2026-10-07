import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../telemetry/db.js';

export interface ContextRunInput {
  readonly sessionId: string;
  readonly prompt: string;
  readonly mode: 'inject' | 'shadow' | 'off';
  readonly outcome: 'ok' | 'skipped_origin' | 'config_error' | 'partial' | 'source_error' | 'jev_error' | 'timeout';
  readonly pipelineVersion: string;
  readonly injected: boolean;
  readonly injectedChars: number;
}

export interface ContextCandidateInput {
  readonly type: 'memory' | 'graph';
  readonly path: string;
  readonly title?: string | null;
  readonly content: string;
  readonly p: number;
  readonly injected: boolean;
}

/**
 * Records a context hook run and all evaluated candidates in a single database transaction.
 * Returns the auto-incremented ID of the created context_runs row.
 */
export function recordContextRun(
  db: DatabaseSync,
  run: ContextRunInput,
  candidates: readonly ContextCandidateInput[]
): number {
  let runId = -1;

  inTransaction(db, () => {
    const insertRun = db.prepare(`
      INSERT INTO context_runs (
        session_id, prompt, mode, outcome, pipeline_version, injected, injected_chars
      ) VALUES (
        @sessionId, @prompt, @mode, @outcome, @pipelineVersion, @injected, @injectedChars
      )
    `);

    const runResult = insertRun.run({
      sessionId: run.sessionId,
      prompt: run.prompt,
      mode: run.mode,
      outcome: run.outcome,
      pipelineVersion: run.pipelineVersion,
      injected: run.injected ? 1 : 0,
      injectedChars: run.injectedChars,
    });

    runId = Number(runResult.lastInsertRowid);

    if (candidates.length > 0) {
      const insertCandidate = db.prepare(`
        INSERT INTO context_candidates (
          run_id, type, path, title, content, p, injected
        ) VALUES (
          @runId, @type, @path, @title, @content, @p, @injected
        )
      `);

      for (const cand of candidates) {
        insertCandidate.run({
          runId,
          type: cand.type,
          path: cand.path,
          title: cand.title ?? null,
          content: cand.content,
          p: cand.p,
          injected: cand.injected ? 1 : 0,
        });
      }
    }
  });

  return runId;
}
