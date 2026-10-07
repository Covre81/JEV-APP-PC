import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClassificationInput, ComplexityClassifier } from '../src/classifier/classifier.js';
import type { ComplexityDistribution } from '../src/domain/complexity.js';
import type { Tier } from '../src/domain/policy.js';
import { MessagesBody } from '../src/routing/messages-body.js';
import { Router, type RequestContext } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

const SIMPLE: ComplexityDistribution = { simple: 0.92, standard: 0.06, structural: 0.02 };
const STRUCTURAL: ComplexityDistribution = { simple: 0.03, standard: 0.12, structural: 0.85 };

class ScriptedClassifier implements ComplexityClassifier {
  readonly name = 'scripted';
  calls: ClassificationInput[] = [];
  constructor(private readonly next: () => ComplexityDistribution | Error) {}
  classify(input: ClassificationInput): Promise<ComplexityDistribution> {
    this.calls.push(input);
    const r = this.next();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

function setup(script: () => ComplexityDistribution | Error, { standard = false } = {}) {
  const classifier = new ScriptedClassifier(script);
  const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
    policy: { minCheapProbability: 0.8, standardRoute: 'primary', standardEnabled: standard, minStandardProbability: 0.75 },
    primaryClasses: new Set(['auxiliary', 'compaction']),
    cheapContextTokens: 100_000,
    standardContextTokens: 250_000,
    classifierTimeoutMs: 1_000,
    classifierMaxChars: 4_000,
  });
  return { classifier, router };
}

/** Level-2 work: not confidently simple, but little structural mass. */
const STANDARD: ComplexityDistribution = { simple: 0.4, standard: 0.5, structural: 0.1 };

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantToolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] };
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] };
const assistantText = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };

function ctx(messages: unknown[], overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    body: MessagesBody.parse({ model: 'claude-opus-5-5', messages }),
    rawByteLength: 30_000,
    sessionId: 'S1',
    agentId: undefined,
    requestClass: 'main',
    contextCompacted: false,
    ...overrides,
  };
}

/**
 * First turn as Claude Code 2.1.289 actually sends it (captured, trimmed): context
 * reminders, then the typed prompt, then SessionStart hook output as an inline
 * `system` message closing the array.
 */
const realFirstTurn = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>\nCodebase and user instructions…\n</system-reminder>' },
      { type: 'text', text: 'explain this hook' },
    ],
  },
  {
    role: 'system',
    content: [
      { type: 'text', text: 'SessionStart:startup hook success: PONYTAIL MODE ACTIVE' },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'advisor' } },
    ],
  },
];
const hookOutput = { role: 'system', content: [{ type: 'text', text: 'UserPromptSubmit hook success' }] };

describe('Router (multi-provider)', () => {
  it('routes a simple fresh conversation to the cheap provider', async () => {
    const { router } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('explain this hook')]));
    assert.deepEqual([d.route, d.reason], ['cheap', 'classified']);
  });

  it('classifies a real first turn whose hook output trails as a system message', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    const d = await router.decide(ctx(realFirstTurn));
    assert.deepEqual([d.route, d.reason], ['cheap', 'classified']);
    assert.equal(classifier.calls[0]?.text, 'explain this hook');
  });

  it('re-classifies a new human turn followed by hook output', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    await router.decide(ctx(realFirstTurn));
    await router.decide(ctx([...realFirstTurn, assistantText, user('now rename it'), hookOutput]));
    assert.equal(classifier.calls[1]?.text, 'now rename it');
  });

  it('routes structural work to the primary', async () => {
    const { router } = setup(() => STRUCTURAL);
    const d = await router.decide(ctx([user('refactor to clean architecture')]));
    assert.deepEqual([d.route, d.reason], ['primary', 'classified']);
  });

  it('keeps the agent loop on its route without re-classifying', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    await router.decide(ctx([user('rename x')]));
    const d = await router.decide(ctx([user('rename x'), assistantToolUse, toolResult]));
    assert.deepEqual([d.route, d.reason], ['cheap', 'sticky']);
    assert.equal(classifier.calls.length, 1);
  });

  it('escalates a cheap conversation on a structural turn, then stays primary without asking JEV', async () => {
    const scripts = [SIMPLE, STRUCTURAL];
    const { router, classifier } = setup(() => scripts.shift()!);
    await router.decide(ctx([user('rename x')]));

    const up = await router.decide(ctx([user('rename x'), assistantText, user('now redesign the layers')]));
    assert.deepEqual([up.route, up.reason], ['primary', 'escalated']);

    const stay = await router.decide(ctx([user('rename x'), assistantText, user('a'), assistantText, user('rename y')]));
    assert.deepEqual([stay.route, stay.reason], ['primary', 'sticky']);
    assert.equal(classifier.calls.length, 2);
  });

  it('fails toward the primary when JEV errors', async () => {
    const { router } = setup(() => new Error('timeout'));
    const d = await router.decide(ctx([user('anything')]));
    assert.deepEqual([d.route, d.reason], ['primary', 'passthrough:classifier-failed']);
  });

  it('escalates a cheap conversation when JEV fails on a new human turn', async () => {
    let script: () => ComplexityDistribution | Error = () => SIMPLE;
    const { router } = setup(() => script());
    assert.equal((await router.decide(ctx([user('fix the typo')]))).route, 'cheap');

    script = () => new Error('timeout');
    const d = await router.decide(ctx([user('fix the typo'), assistantText, user('now redesign the module')]));
    assert.deepEqual([d.route, d.reason], ['primary', 'passthrough:classifier-failed']);

    const next = await router.decide(ctx([user('fix the typo'), assistantText, user('now redesign the module'), assistantToolUse, toolResult]));
    assert.deepEqual([next.route, next.reason], ['primary', 'sticky'], 'primary is terminal');
  });

  it('keeps auxiliary and compaction traffic on the primary', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('title this')], { requestClass: 'auxiliary' }));
    assert.deepEqual([d.route, d.reason], ['primary', 'passthrough:request-class']);
    assert.equal(classifier.calls.length, 0);
  });

  it('treats unknown ongoing conversations as primary', async () => {
    const { router } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('a'), assistantText, user('b')]));
    assert.deepEqual([d.route, d.reason], ['primary', 'sticky']);
  });

  it('escalates when the conversation outgrows the cheap context budget', async () => {
    const { router } = setup(() => SIMPLE);
    await router.decide(ctx([user('small')]));
    const d = await router.decide(ctx([user('small'), assistantToolUse, toolResult], { rawByteLength: 600_000 }));
    assert.deepEqual([d.route, d.reason], ['primary', 'escalated:context']);
  });

  it('routes subagents independently', async () => {
    const scripts = [STRUCTURAL, SIMPLE];
    const { router } = setup(() => scripts.shift()!);
    await router.decide(ctx([user('architect it')]));
    const sub = await router.decide(ctx([user('grep for foo')], { agentId: 'agent-1', requestClass: 'subagent' }));
    assert.equal(sub.route, 'cheap');
  });

  it('pinToPrimary moves a cheap conversation to the primary for good', async () => {
    const { router } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('rename x')]));
    router.pinToPrimary(d);
    const next = await router.decide(ctx([user('rename x'), assistantToolUse, toolResult]));
    assert.equal(next.route, 'primary');
  });

  it('sends level-2 work to the standard tier on the cheap route, and only ever moves the tier up', async () => {
    const scripts = [SIMPLE, STANDARD, SIMPLE, STRUCTURAL];
    const { router } = setup(() => scripts.shift()!, { standard: true });
    const first = await router.decide(ctx([user('rename x')]));
    assert.deepEqual([first.route, first.tier, first.reason], ['cheap', 'trivial', 'classified']);

    const t2 = [user('rename x'), assistantText, user('now add pagination to the list')];
    const up = await router.decide(ctx(t2));
    assert.deepEqual([up.route, up.tier, up.reason], ['cheap', 'standard', 'escalated:standard']);

    const t3 = [...t2, assistantText, user('fix the typo')];
    const stay = await router.decide(ctx(t3));
    assert.deepEqual([stay.route, stay.tier, stay.reason], ['cheap', 'standard', 'sticky'], 'never back down to trivial');

    const top = await router.decide(ctx([...t3, assistantText, user('redesign the layers')]));
    assert.deepEqual([top.route, top.tier, top.reason], ['primary', 'primary', 'escalated']);
  });

  it('never picks the standard tier when it is off', async () => {
    const { router } = setup(() => STANDARD);
    const d = await router.decide(ctx([user('add pagination')]));
    assert.deepEqual([d.route, d.tier], ['primary', 'primary']);
  });

  it('gives the standard tier its own context budget', async () => {
    const { router } = setup(() => STANDARD, { standard: true });
    await router.decide(ctx([user('add pagination')]));
    const fits = await router.decide(ctx([user('add pagination'), assistantToolUse, toolResult], { rawByteLength: 600_000 }));
    assert.deepEqual([fits.route, fits.tier], ['cheap', 'standard'], '~200k tokens: over trivial, under standard');
    const over = await router.decide(ctx([user('add pagination'), assistantToolUse, toolResult], { rawByteLength: 1_000_000 }));
    assert.deepEqual([over.route, over.reason], ['primary', 'escalated:context']);
  });

  it('strips system-reminders before classifying', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    await router.decide(ctx([user('<system-reminder>huge context</system-reminder>do X')]));
    assert.equal(classifier.calls[0]?.text, 'do X');
  });
});
