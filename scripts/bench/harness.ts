/**
 * Tool-use benchmark for the cheap provider: a minimal Claude Code agent loop
 * (Read, Edit and the usual distractor tools) driven through the real
 * OpenAICompatibleProvider, so the model sees exactly the translated request
 * the router would send and we read exactly the Anthropic stream Claude Code
 * would read.
 *
 * The workspace is in memory: nothing touches the disk and every trial starts
 * from the same files.
 */
import { z } from 'zod';
import type { Provider } from '../../src/providers/provider.js';
import { readSseData } from '../../src/providers/openai/sse.js';
import { parseMessagesBody } from '../../src/routing/messages-body.js';

export const ROOT = '/workspace';

// ─── Tools (Claude Code shapes, strict like Claude Code's own validation) ────

const absolutePath = z.string().refine((p) => p.startsWith('/'), 'file_path must be an absolute path');

const ToolInputs = {
  Read: z.strictObject({
    file_path: absolutePath,
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().positive().optional(),
  }),
  Edit: z.strictObject({
    file_path: absolutePath,
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  Write: z.strictObject({ file_path: absolutePath, content: z.string() }),
  Glob: z.strictObject({ pattern: z.string(), path: z.string().optional() }),
  Grep: z.strictObject({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  }),
  Bash: z.strictObject({
    command: z.string(),
    description: z.string().optional(),
    timeout: z.number().optional(),
  }),
} as const;

type ToolName = keyof typeof ToolInputs;

const DESCRIPTIONS: Record<ToolName, string> = {
  Read: 'Reads a file from the local filesystem. file_path must be absolute. Lines are returned as "<line number>→<content>". You must Read a file before editing it.',
  Edit: 'Performs exact string replacement in a file. old_string must match the file exactly (without the line-number prefix from Read) and be unique unless replace_all is true. The file must have been Read first.',
  Write: 'Writes a file, overwriting it. An existing file must be Read first. Prefer Edit for changes to existing files.',
  Glob: 'Fast file pattern matching, e.g. "**/*.ts". Returns matching absolute paths.',
  Grep: 'Searches file contents with a regular expression.',
  Bash: 'Executes a shell command.',
};

function stripSchemaKey(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

export const TOOLS = (Object.keys(ToolInputs) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  input_schema: stripSchemaKey(z.toJSONSchema(ToolInputs[name]) as Record<string, unknown>),
}));

// ─── Workspace ───────────────────────────────────────────────────────────────

export interface Counters {
  hallucinatedTool: number;
  schemaViolation: number;
  fileNotFound: number;
  editWithoutRead: number;
  editMiss: number;
  disallowedTool: number;
}

const zeroCounters = (): Counters => ({
  hallucinatedTool: 0,
  schemaViolation: 0,
  fileNotFound: 0,
  editWithoutRead: 0,
  editMiss: 0,
  disallowedTool: 0,
});

interface ToolOutcome {
  readonly content: string;
  readonly isError: boolean;
}

export class Workspace {
  readonly files: Map<string, string>;
  private readonly read = new Set<string>();
  readonly counters = zeroCounters();
  /** Every failed call as `Tool(input): first line of the error`, in call order. */
  readonly errors: string[] = [];

  constructor(initial: Readonly<Record<string, string>>) {
    this.files = new Map(Object.entries(initial).map(([name, text]) => [`${ROOT}/${name}`, text]));
  }

  file(name: string): string | undefined {
    return this.files.get(`${ROOT}/${name}`);
  }

  run(name: string, input: unknown): ToolOutcome {
    const out = this.dispatch(name, input);
    if (out.isError) {
      const message = out.content.replace(/<\/?tool_use_error>/g, '').replace(/\n/g, ' | ');
      this.errors.push(`${name}(${JSON.stringify(input)?.slice(0, 160)}): ${message.slice(0, 200)}`);
    }
    return out;
  }

  private dispatch(name: string, input: unknown): ToolOutcome {
    if (!(name in ToolInputs)) {
      this.counters.hallucinatedTool++;
      return fail(`Error: No such tool available: ${name}`);
    }
    const tool = name as ToolName;
    const parsed = ToolInputs[tool].safeParse(input);
    if (!parsed.success) {
      this.counters.schemaViolation++;
      return fail(
        `InputValidationError: ${tool} failed due to the following issues:\n` +
          parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('\n'),
      );
    }

    switch (tool) {
      case 'Read':
        return this.readFile(parsed.data as z.infer<typeof ToolInputs.Read>);
      case 'Edit':
        return this.editFile(parsed.data as z.infer<typeof ToolInputs.Edit>);
      case 'Write':
        return this.writeFile(parsed.data as z.infer<typeof ToolInputs.Write>);
      case 'Glob':
        return this.glob((parsed.data as z.infer<typeof ToolInputs.Glob>).pattern);
      case 'Grep':
        return this.grep(parsed.data as z.infer<typeof ToolInputs.Grep>);
      case 'Bash':
        this.counters.disallowedTool++;
        return fail('Bash is not permitted in this session. Use Read, Edit, Glob or Grep.');
    }
  }

  private readFile({ file_path, offset, limit }: z.infer<typeof ToolInputs.Read>): ToolOutcome {
    const text = this.files.get(file_path);
    if (text === undefined) {
      this.counters.fileNotFound++;
      return fail(`File does not exist: ${file_path}`);
    }
    this.read.add(file_path);
    const start = (offset ?? 1) - 1;
    const lines = text.split('\n').slice(start, limit === undefined ? undefined : start + limit);
    return ok(lines.map((line, i) => `${String(start + i + 1).padStart(6)}→${line}`).join('\n'));
  }

  private editFile({ file_path, old_string, new_string, replace_all }: z.infer<typeof ToolInputs.Edit>): ToolOutcome {
    const text = this.files.get(file_path);
    if (text === undefined) {
      this.counters.fileNotFound++;
      return fail(`File does not exist: ${file_path}`);
    }
    if (!this.read.has(file_path)) {
      this.counters.editWithoutRead++;
      return fail('File has not been read yet. Read it first before writing to it.');
    }
    if (old_string === new_string) {
      this.counters.editMiss++;
      return fail('No changes to make: old_string and new_string are exactly the same.');
    }
    const matches = old_string === '' ? 0 : text.split(old_string).length - 1;
    if (matches === 0) {
      this.counters.editMiss++;
      return fail(`String to replace not found in file.\nString: ${old_string}`);
    }
    if (matches > 1 && !replace_all) {
      this.counters.editMiss++;
      return fail(`Found ${matches} matches of the string to replace, but replace_all is false.`);
    }
    this.files.set(file_path, replace_all ? text.replaceAll(old_string, new_string) : text.replace(old_string, () => new_string));
    return ok(`The file ${file_path} has been updated.`);
  }

  private writeFile({ file_path, content }: z.infer<typeof ToolInputs.Write>): ToolOutcome {
    if (this.files.has(file_path) && !this.read.has(file_path)) {
      this.counters.editWithoutRead++;
      return fail('File has not been read yet. Read it first before writing to it.');
    }
    this.files.set(file_path, content);
    this.read.add(file_path);
    return ok(`File written: ${file_path}`);
  }

  private glob(pattern: string): ToolOutcome {
    const re = globToRegExp(pattern.startsWith('/') ? pattern : `${ROOT}/${pattern}`);
    const hits = [...this.files.keys()].filter((f) => re.test(f));
    return ok(hits.length > 0 ? hits.join('\n') : 'No files found');
  }

  private grep({ pattern, glob, output_mode }: z.infer<typeof ToolInputs.Grep>): ToolOutcome {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      this.counters.schemaViolation++;
      return fail(`Invalid regex: ${(err as Error).message}`);
    }
    const scope = glob ? globToRegExp(`${ROOT}/${glob}`) : undefined;
    const out: string[] = [];
    for (const [path, text] of this.files) {
      if (scope && !scope.test(path)) continue;
      const lines = text.split('\n').flatMap((line, i) => (re.test(line) ? [`${path}:${i + 1}:${line}`] : []));
      if (lines.length === 0) continue;
      if (output_mode === 'content') out.push(...lines);
      else if (output_mode === 'count') out.push(`${path}:${lines.length}`);
      else out.push(path);
    }
    return ok(out.length > 0 ? out.join('\n') : 'No matches found');
  }
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const fail = (message: string): ToolOutcome => ({ content: `<tool_use_error>${message}</tool_use_error>`, isError: true });

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface BenchTask {
  readonly id: string;
  readonly prompt: string;
  readonly files: Readonly<Record<string, string>>;
  /** null when the task was done right, else why not. */
  verify(ws: Workspace, finalText: string): string | null;
}

const unchanged = (ws: Workspace, files: Readonly<Record<string, string>>): string | null => {
  for (const [name, text] of Object.entries(files)) if (ws.file(name) !== text) return `${name} was modified`;
  for (const path of ws.files.keys()) if (!(path.slice(ROOT.length + 1) in files)) return `created ${path}`;
  return null;
};

const MATH = `export function add(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

const GREET = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

const MAIN = `import { greet } from './greet.js';

console.log(greet('Bruno'));
`;

const CONFIG = `{
  "name": "orders-api",
  "port": 8080,
  "debug": false
}
`;

export const TASKS: readonly BenchTask[] = [
  {
    id: 'fix-bug',
    prompt: 'The add function in math.ts returns the wrong result. Fix it.',
    files: { 'math.ts': MATH },
    verify(ws) {
      const math = ws.file('math.ts') ?? '';
      if (!/return a \+ b;/.test(math)) return 'add still does not return a + b';
      if (!math.includes('return a * b;')) return 'multiply was broken';
      return null;
    },
  },
  {
    id: 'rename',
    prompt: 'Rename the function greet to welcome in greet.ts and update its usage in main.ts.',
    files: { 'greet.ts': GREET, 'main.ts': MAIN },
    verify(ws) {
      const greet = ws.file('greet.ts') ?? '';
      const main = ws.file('main.ts') ?? '';
      if (!greet.includes('export function welcome(name: string)')) return 'greet.ts does not export welcome';
      if (!main.includes("import { welcome } from './greet.js'")) return 'main.ts import not updated';
      if (!main.includes("welcome('Bruno')")) return 'main.ts call not updated';
      if (/\bgreet\(/.test(greet + main)) return 'a greet( call remains';
      return null;
    },
  },
  {
    id: 'read-answer',
    prompt: 'Which port does the service configured in config.json listen on? Answer with the number only.',
    files: { 'config.json': CONFIG },
    verify(ws, finalText) {
      if (!finalText.includes('8080')) return `answer does not contain 8080: ${JSON.stringify(finalText.slice(0, 80))}`;
      return unchanged(ws, { 'config.json': CONFIG });
    },
  },
];

// ─── Agent loop ──────────────────────────────────────────────────────────────

/**
 * - success: task verified.
 * - wrong_result: the model stopped calling tools but the files/answer are wrong.
 * - max_steps: still calling tools after the step budget.
 * - fallback: the provider refused before the first byte. The router sends
 *   this turn to Anthropic (cost: full-price history re-send).
 * - stream_error: the stream broke after it started (e.g. invalid tool JSON).
 *   The router sends an error event; Claude Code retries and the retry goes
 *   to Anthropic (cost: full-price history re-send).
 * - truncated: stop_reason max_tokens or refusal.
 */
export type TrialOutcome = 'success' | 'wrong_result' | 'max_steps' | 'fallback' | 'stream_error' | 'truncated';

export interface TrialResult {
  readonly task: string;
  readonly outcome: TrialOutcome;
  readonly detail: string | undefined;
  readonly steps: number;
  readonly toolCalls: readonly string[];
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly counters: Counters;
  readonly toolErrors: readonly string[];
}

export interface TrialOptions {
  readonly maxSteps: number;
  /** Extra system-prompt KB, to approach Claude Code's real context size. */
  readonly padKb: number;
  readonly maxTokens: number;
  readonly stepTimeoutMs: number;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface AssistantTurn {
  readonly content: ContentBlock[];
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

class StreamError extends Error {}

const PAD_PARAGRAPH =
  'Follow the existing code style. Keep changes minimal and focused on the request. Never invent file paths: ' +
  'use Glob or Grep to locate files. Read a file before editing it. Prefer Edit over Write for existing files. ';

export function systemPrompt(padKb: number): string {
  const base = [
    'You are an interactive CLI coding agent. Use the tools to complete the user request.',
    `Working directory: ${ROOT}. All file paths passed to tools must be absolute.`,
    'When the task is done, reply with a short final message and stop calling tools.',
  ].join('\n');
  if (padKb <= 0) return base;
  const target = padKb * 1024;
  const parts: string[] = [];
  for (let n = 1, size = 0; size < target; n++) {
    const line = `Guideline ${n}: ${PAD_PARAGRAPH}`;
    parts.push(line);
    size += line.length + 1;
  }
  return `${base}\n\n# Guidelines\n${parts.join('\n')}`;
}

export async function runTrial(provider: Provider, task: BenchTask, options: TrialOptions): Promise<TrialResult> {
  const ws = new Workspace(task.files);
  const system = systemPrompt(options.padKb);
  const messages: object[] = [{ role: 'user', content: [{ type: 'text', text: task.prompt }] }];
  const toolCalls: string[] = [];
  const started = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;

  const result = (outcome: TrialOutcome, steps: number, detail?: string): TrialResult => ({
    task: task.id,
    outcome,
    detail,
    steps,
    toolCalls,
    latencyMs: Math.round(performance.now() - started),
    inputTokens,
    outputTokens,
    counters: { ...ws.counters },
    toolErrors: [...ws.errors],
  });

  for (let step = 1; step <= options.maxSteps; step++) {
    const rawBody = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: options.maxTokens,
        stream: true,
        system: [{ type: 'text', text: system }],
        tools: TOOLS,
        messages,
      }),
    );
    const sent = await provider.send({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      rawBody,
      body: parseMessagesBody(rawBody),
      signal: AbortSignal.timeout(options.stepTimeoutMs),
    });
    if (sent.kind === 'unavailable') return result('fallback', step, sent.reason);

    let turn: AssistantTurn;
    try {
      turn = await readAnthropicStream(sent.body);
    } catch (err) {
      return result('stream_error', step, err instanceof Error ? err.message : String(err));
    }
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;

    if (turn.stopReason === 'max_tokens' || turn.stopReason === 'refusal') {
      return result('truncated', step, `stop_reason ${turn.stopReason}`);
    }

    const uses = turn.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (uses.length === 0) {
      const finalText = turn.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const failure = task.verify(ws, finalText);
      return failure === null ? result('success', step) : result('wrong_result', step, failure);
    }

    messages.push({ role: 'assistant', content: turn.content });
    messages.push({
      role: 'user',
      content: uses.map((use) => {
        toolCalls.push(use.name);
        const out = ws.run(use.name, use.input);
        return { type: 'tool_result', tool_use_id: use.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
      }),
    });
  }
  return result('max_steps', options.maxSteps, `still calling tools after ${options.maxSteps} steps`);
}

/** Rebuilds the assistant message from the Anthropic SSE stream, as Claude Code does. */
export async function readAnthropicStream(body: AsyncIterable<Buffer | string>): Promise<AssistantTurn> {
  const blocks = new Map<number, ContentBlock & { json?: string }>();
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopped = false;

  for await (const data of readSseData(body)) {
    const event = JSON.parse(data) as Record<string, any>;
    switch (event['type']) {
      case 'message_start':
        inputTokens = event['message']?.usage?.input_tokens ?? 0;
        break;
      case 'content_block_start': {
        const b = event['content_block'];
        blocks.set(event['index'], b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {}, json: '' } : { type: 'text', text: b.text ?? '' });
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(event['index']);
        const delta = event['delta'];
        if (block?.type === 'text' && delta.type === 'text_delta') block.text += delta.text;
        if (block?.type === 'tool_use' && delta.type === 'input_json_delta') block.json += delta.partial_json;
        break;
      }
      case 'message_delta':
        stopReason = event['delta']?.stop_reason ?? null;
        inputTokens = event['usage']?.input_tokens || inputTokens;
        outputTokens = event['usage']?.output_tokens ?? 0;
        break;
      case 'message_stop':
        stopped = true;
        break;
      case 'error':
        throw new StreamError(event['error']?.message ?? 'error event');
    }
  }
  if (!stopped) throw new StreamError('stream ended without message_stop');

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]): ContentBlock => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      let input: unknown;
      try {
        input = JSON.parse(b.json || '{}');
      } catch {
        throw new StreamError(`tool ${b.name}: invalid JSON input`);
      }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    });
  return { content, stopReason, inputTokens, outputTokens };
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface BenchSummary {
  readonly model: string;
  readonly trials: number;
  readonly successRate: number;
  /** Trials the router would see as provider failures (fallback, stream_error, truncated). */
  readonly failureRate: number;
  readonly byTask: Readonly<Record<string, { runs: number; success: number; outcomes: Partial<Record<TrialOutcome, number>> }>>;
  readonly counters: Counters;
  readonly avgLatencyMs: number;
  readonly results: readonly TrialResult[];
}

export function summarize(model: string, results: readonly TrialResult[]): BenchSummary {
  const byTask: Record<string, { runs: number; success: number; outcomes: Partial<Record<TrialOutcome, number>> }> = {};
  const counters = zeroCounters();
  for (const r of results) {
    const t = (byTask[r.task] ??= { runs: 0, success: 0, outcomes: {} });
    t.runs++;
    if (r.outcome === 'success') t.success++;
    t.outcomes[r.outcome] = (t.outcomes[r.outcome] ?? 0) + 1;
    for (const k of Object.keys(counters) as (keyof Counters)[]) counters[k] += r.counters[k];
  }
  const n = results.length || 1;
  const count = (pred: (r: TrialResult) => boolean) => results.filter(pred).length;
  return {
    model,
    trials: results.length,
    successRate: count((r) => r.outcome === 'success') / n,
    failureRate: count((r) => r.outcome === 'fallback' || r.outcome === 'stream_error' || r.outcome === 'truncated') / n,
    byTask,
    counters,
    avgLatencyMs: Math.round(results.reduce((a, r) => a + r.latencyMs, 0) / n),
    results,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function renderSummary(s: BenchSummary, minSuccess: number): string {
  const lines = [`Tool-use benchmark: ${s.model}, ${s.trials} trials`, ''];
  lines.push('task          success  outcomes');
  for (const [id, t] of Object.entries(s.byTask)) {
    const outcomes = Object.entries(t.outcomes).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`${id.padEnd(13)} ${`${t.success}/${t.runs}`.padStart(7)}  ${outcomes}`);
  }
  lines.push('');
  lines.push(`success rate         ${pct(s.successRate)}  (threshold ${pct(minSuccess)})`);
  lines.push(`provider failures    ${pct(s.failureRate)}  (fallback / stream_error / truncated)`);
  lines.push(`avg trial latency    ${s.avgLatencyMs} ms`);
  const c = s.counters;
  lines.push(
    `tool errors          hallucinated=${c.hallucinatedTool} schema=${c.schemaViolation} file_not_found=${c.fileNotFound} ` +
      `edit_without_read=${c.editWithoutRead} edit_miss=${c.editMiss} bash=${c.disallowedTool}`,
  );
  const errors = s.results.flatMap((r) => r.toolErrors.map((e) => `${r.task}: ${e}`));
  if (errors.length > 0) {
    lines.push('', `tool error samples (${Math.min(errors.length, 12)} of ${errors.length}):`);
    for (const e of errors.slice(0, 12)) lines.push(`  ${e}`);
  }
  const failures = s.results.filter((r) => r.outcome !== 'success');
  if (failures.length > 0) {
    lines.push('', 'failures:');
    for (const r of failures) lines.push(`  ${r.task} ${r.outcome} @step ${r.steps}: ${r.detail ?? ''}`.trimEnd());
  }
  lines.push('');
  lines.push(
    s.successRate >= minSuccess
      ? `PASS: ${s.model} handles the basic Read/Edit loop.`
      : s.failureRate >= 0.2
        ? `FAIL: ${s.model} breaks the stream or is refused too often. Expect chronic fallback to Anthropic.`
        : `FAIL: ${s.model} completes the protocol but gets the work wrong. Expect silent quality loss.`,
  );
  return lines.join('\n');
}
