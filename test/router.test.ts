import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClassificationInput, ComplexityClassifier } from '../src/classifier/classifier.js';
import type { Tier, TierScores } from '../src/domain/tiers.js';
import { MessagesBody } from '../src/routing/messages-body.js';
import { Router, type RequestContext } from '../src/routing/router.js';
import { TtlLruStore } from '../src/routing/session-store.js';

const SIMPLE: TierScores = { haiku: 95, sonnet: 99, opus: 100 };
const MEDIUM: TierScores = { haiku: 20, sonnet: 90, opus: 100 };
const HARD: TierScores = { haiku: 5, sonnet: 30, opus: 100 };

class ScriptedClassifier implements ComplexityClassifier {
  readonly name = 'scripted';
  calls: ClassificationInput[] = [];
  constructor(private readonly next: () => TierScores | Error) {}
  classify(input: ClassificationInput): Promise<TierScores> {
    this.calls.push(input);
    const r = this.next();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

function setup(script: () => TierScores | Error, allowEscalation = true) {
  const classifier = new ScriptedClassifier(script);
  const router = new Router(classifier, new TtlLruStore<Tier>(100, 60_000), {
    threshold: 80,
    allowEscalation,
    passthroughClasses: new Set(['auxiliary', 'compaction']),
    models: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
    classifierTimeoutMs: 1_000,
    classifierMaxChars: 4_000,
  });
  return { classifier, router };
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantToolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] };
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] };
const assistantText = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };

function ctx(messages: unknown[], overrides: Partial<RequestContext> = {}, model = 'claude-opus-5-5'): RequestContext {
  return {
    body: MessagesBody.parse({ model, messages }),
    rawByteLength: 10_000,
    sessionId: 'S1',
    agentId: undefined,
    requestClass: 'main',
    contextCompacted: false,
    mayClassify: true,
    ...overrides,
  };
}

describe('Router', () => {
  it('classifies a fresh conversation and routes down', async () => {
    const { router } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('fix the typo in README')]));
    assert.equal(d.model, 'claude-haiku-4-5');
    assert.equal(d.reason, 'classified');
  });

  it('keeps the tier for tool-result continuations without re-classifying', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    await router.decide(ctx([user('fix typo')]));
    const d = await router.decide(ctx([user('fix typo'), assistantToolUse, toolResult]));
    assert.equal(d.model, 'claude-haiku-4-5');
    assert.equal(d.reason, 'sticky');
    assert.equal(classifier.calls.length, 1);
  });

  it('escalates on a harder new human turn but never de-escalates', async () => {
    const scripts = [SIMPLE, HARD, SIMPLE];
    const { router } = setup(() => scripts.shift()!);
    const history = [user('rename x'), assistantText];
    await router.decide(ctx([user('rename x')]));

    const up = await router.decide(ctx([...history, user('now redesign the concurrency model')]));
    assert.equal(up.model, 'claude-opus-5-5');
    assert.equal(up.reason, 'escalated');

    const stay = await router.decide(ctx([...history, user('x'), assistantText, user('thanks, rename y')]));
    assert.equal(stay.model, 'claude-opus-5-5');
    assert.equal(stay.reason, 'sticky');
  });

  it('treats the requested model as a ceiling and keeps its exact id', async () => {
    const { router } = setup(() => HARD);
    const d = await router.decide(ctx([user('hard')], {}, 'claude-fable-5-1'));
    assert.equal(d.model, 'claude-fable-5-1');

    const capped = await router.decide(ctx([user('hard')], { sessionId: 'S2' }, 'claude-sonnet-5-5'));
    assert.equal(capped.model, 'claude-sonnet-5-5');
  });

  it('fails open to the requested model when the classifier errors', async () => {
    const { router } = setup(() => new Error('timeout'));
    const d = await router.decide(ctx([user('anything')]));
    assert.equal(d.model, 'claude-opus-5-5');
    assert.equal(d.reason, 'passthrough:classifier-failed');
  });

  it('does not route auxiliary or compaction traffic', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('title this')], { requestClass: 'auxiliary' }));
    assert.equal(d.reason, 'passthrough:request-class');
    assert.equal(classifier.calls.length, 0);
  });

  it('assumes the requested tier for conversations it has no state for', async () => {
    const { router } = setup(() => SIMPLE);
    const d = await router.decide(ctx([user('a'), assistantText, user('b')]));
    assert.equal(d.model, 'claude-opus-5-5');
    assert.equal(d.reason, 'sticky');
  });

  it('bumps a sticky tier whose context window the conversation outgrew', async () => {
    const { router } = setup(() => SIMPLE);
    await router.decide(ctx([user('small')]));
    const d = await router.decide(ctx([user('small'), assistantToolUse, toolResult], { rawByteLength: 900_000 }));
    assert.equal(d.model, 'claude-sonnet-5-5');
    assert.equal(d.reason, 'escalated:context');
  });

  it('keeps subagents independent from the main conversation', async () => {
    const scripts = [HARD, SIMPLE];
    const { router } = setup(() => scripts.shift()!);
    await router.decide(ctx([user('architect it')]));
    const sub = await router.decide(ctx([user('grep for foo')], { agentId: 'agent-1', requestClass: 'subagent' }));
    assert.equal(sub.model, 'claude-haiku-4-5');
  });

  it('count_tokens reuses the decision and never classifies', async () => {
    const { router, classifier } = setup(() => MEDIUM);
    await router.decide(ctx([user('feature')]));
    const d = await router.decide(ctx([user('feature')], { mayClassify: false }));
    assert.equal(d.model, 'claude-sonnet-5-5');
    assert.equal(classifier.calls.length, 1);
  });

  it('strips system-reminders before classifying', async () => {
    const { router, classifier } = setup(() => SIMPLE);
    await router.decide(ctx([user('<system-reminder>huge context</system-reminder>do X')]));
    assert.equal(classifier.calls[0]?.text, 'do X');
  });
});
