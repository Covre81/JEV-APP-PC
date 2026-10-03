# jev-router

A local, Anthropic-compatible gateway for Claude Code (or any Messages-API
client) that uses **TypeSafe JEV** as a System One classifier to keep simple
work off your Claude quota.

- **Simple work** goes to a cheap OpenAI-compatible provider, such as Groq or
  OpenRouter.
- **Structural work** goes to Anthropic.

```
                                      ┌─ simple ───▶ Groq / OpenRouter  (/chat/completions, translated)
Claude Code ──▶ jev-router :8787 ──┤
                    │                 └─ structural ─▶ Anthropic          (/v1/messages, byte-for-byte)
                    └─ new human turn ─▶ JEV /v1/systemone
```

## Routing model (ADR) — the adopted design

**Status:** adopted. It replaces the earlier Haiku → Sonnet → Opus ladder.

**Context.** On a Claude subscription, routing *between Claude models* cuts no
bill. Every model draws from the same quota. On top of that, switching models
mid-conversation discards the model-scoped prompt cache. Moving between Claude
models only moves the cost around. The goal is to **spend the Claude quota
only on work that needs Claude**.

**Decision.** Use two providers with different billing:

| Route | Provider | Billing | Gets |
|---|---|---|---|
| `cheap` | Any OpenAI-compatible API (default: Groq `openai/gpt-oss-20b`) | Per token, separate account | JEV level 1, the simple tasks: questions, explanations, one-file edits, renames, docstrings |
| `primary` | Anthropic, with whatever model the client picked | Your Claude quota or API key | Level 3, structural work: Clean Architecture refactors, heavy test design, concurrency, security and performance. Also level 2 by default, plus everything the cheap route can't carry |

**Rules.**

1. **System One decides the route.** JEV answers one ordinal `score`
   question, and the router gets the probability distribution
   `{simple, standard, structural}`.
2. **The cheap route needs confidence, not just a majority.** A task goes
   cheap only when `P(simple) ≥ ROUTER_MIN_CHEAP_PROBABILITY` (default 0.8).
   It does not use the most likely level: `{.45, .30, .25}` has "simple" as
   its top level, but a 55% chance the cheap model is out of its depth.
   Level 2 stays primary unless `ROUTER_STANDARD_ROUTE=cheap`.
3. **The route sticks for the whole conversation.**
   - Tool-result turns of the agent loop reuse the route without calling JEV.
   - A new human turn on the cheap route is re-classified and may escalate.
   - Primary is terminal: going back down would throw away the Anthropic
     cache, and the next escalation would pay to rebuild it.
4. **Failure only ever moves work up to Anthropic.**
   - The request can't be translated (images, documents, server tools): primary.
   - The request is larger than the cheap model's context budget: primary.
   - The cheap provider returns an error or times out: primary, and the
     conversation is pinned there.
   - The cheap provider breaks mid-stream: an Anthropic `error` event is sent,
     the conversation is pinned to primary, and Claude Code retries.
   - JEV fails or times out: primary.
5. **Quota failover in the other direction is opt-in**
   (`FAILOVER_ON_PRIMARY_RATE_LIMIT=true`). When Anthropic answers 429 or 529,
   the request is retried on the cheap provider. It's off by default because
   it silently hands structural work to a 20B model. Turn it on only if you
   prefer a degraded answer to waiting.
6. **Some Claude Code traffic always stays primary**
   (`ROUTER_PRIMARY_CLASSES=auxiliary,compaction`). Claude Code's
   `auxiliary` class includes the auto-mode safety classifier, and compaction
   summaries need the strong model.

**Consequences.**

- **Your code goes to a third party.** The cheap provider sees the full prompt
  and the file contents the agent reads. Check its data policy before pointing
  a client repository at it.
- **This setup is unsupported by Anthropic.** Claude Code is built for Claude
  models. Anthropic's gateway docs state that it doesn't support routing Claude
  Code to non-Claude models. On the cheap route, adaptive thinking, prompt
  caching and server tools (web search, tool search) are gone.
- **Claude Code's agent loop is demanding.** The cheap model has to drive it
  with 20+ tools and a system prompt of tens of thousands of tokens. A 20B
  model does fine on the narrow level-1 band and fails outside it. Hence the
  0.8 bar and level 2 on primary.
- **Rate limits on cheap tiers.** One Claude Code request is roughly 20–40K
  input tokens. Free and dev tiers on cheap providers often have per-minute
  token caps below that. Each rejection fails over to Claude, so you spend the
  very quota you meant to save. Check your tier's limits.
- **Claude Code shows the wrong model name on the cheap route.** It keeps
  showing the model you picked. The truth is in the `x-jev-route` response
  header and the `route decision` log line.

## Repository structure

```
src/
├── index.ts                       # composition root (only file that knows concrete classes)
├── config.ts                      # zod-validated env → typed Config; fails fast at boot
├── domain/                        # pure, no I/O
│   ├── complexity.ts              # ComplexityDistribution (JEV levels 1/2/3)
│   └── policy.ts                  # selectRoute(), stickyRoute(): deterministic decisions
├── classifier/                    # System One port + adapters
│   ├── classifier.ts              # ComplexityClassifier interface
│   ├── jev-classifier.ts          # TypeSafe /v1/systemone adapter
│   └── heuristic-classifier.ts    # offline mock for dev/tests
├── routing/                       # decides; never talks to a provider
│   ├── messages-body.ts           # open-schema parsing of the Anthropic body
│   ├── router.ts                  # stickiness, escalation, context budget, fail-to-primary
│   └── session-store.ts           # TTL + LRU map
├── providers/                     # executes; every provider answers in Anthropic format
│   ├── provider.ts                # Provider port: response | unavailable
│   ├── anthropic.ts               # byte-level forwarder (primary)
│   └── openai/
│       ├── provider.ts            # OpenAI-compatible provider (cheap)
│       ├── translate-request.ts   # Anthropic Messages → Chat Completions
│       ├── translate-response.ts  # Chat Completions JSON/SSE → Anthropic Messages
│       └── sse.ts                 # SSE reader/writer
└── proxy/
    ├── server.ts                  # Fastify routes, failover in both directions
    └── headers.ts                 # hop-by-hop filtering, credential extraction
```

The router returns a decision (`cheap` | `primary`) and knows nothing about
base URLs, headers or wire formats. Providers own all three. That split is
deliberate: adding a provider, or changing how Groq is called, never touches
routing rules, and routing rules are tested without HTTP.

### Translation: shallow, but never lossy

The translator maps exactly what has a 1:1 equivalent, in both directions.

**Request: Anthropic → OpenAI.**

| Anthropic | OpenAI |
|---|---|
| `system` | `system` message |
| text | text |
| `tool_use` | `tool_calls` |
| `tool_result` | `role: tool` messages, placed right after the call |
| `tools[].input_schema` | `functions[].parameters` |
| `tool_choice` | `tool_choice` |
| `stop_sequences` | `stop` |

These are dropped on purpose:

- `thinking` blocks: they are bound to the model that produced them.
- `cache_control`.
- Server tools and deferred tools: the cheap model never sees them.

Anything else throws `NotTranslatableError`, and the request goes to Anthropic.
That covers images, documents, `tool_reference` and server tool results. The
cheap model never sees a conversation with pieces silently missing.

**Response: OpenAI → Anthropic.** This direction is mandatory, because Claude
Code only parses Anthropic events.

- Text deltas stream live.
- Tool calls are buffered and emitted as complete `tool_use` blocks. Buffering
  guarantees a well-formed event sequence, and lets the proxy validate the
  argument JSON *before* Claude Code can run the tool.
- Tool call ids are sanitized to Anthropic's `^[a-zA-Z0-9_-]+$`, so a
  conversation that later escalates replays cleanly on Claude.

## Dependencies

| Package | Why |
|---|---|
| `fastify` | Raw-buffer bodies with a hard `bodyLimit`, streamed replies, pino logging |
| `undici` | One HTTP client for all three upstreams. `request()` exposes the raw, non-decompressed stream that the Anthropic passthrough needs |
| `zod` | Validates env, the body fields we read, and every JEV/OpenAI payload |

Deliberately absent:

- `dotenv`: Node's `--env-file` does the job.
- The Anthropic SDK: a gateway forwards bytes, it doesn't build requests.
- The OpenAI SDK: two endpoints and a stream translator don't justify it.
- An LRU library.

## Setup

```bash
git clone https://github.com/covre81/jev-app-pc.git jev-router && cd jev-router
npm ci
cp .env.example .env
#   TYPESAFE_API_KEY=...   (or CLASSIFIER=heuristic for offline dev)
#   CHEAP_API_KEY=...      (Groq: gsk_..., OpenRouter: sk-or-...)
npm test                   # 33 tests, fake upstreams, no network
npm run build && npm start
curl -s localhost:8787/healthz
```

Requires Node ≥ 22.19.

**Cheap provider presets:**

```bash
# Groq (default)
CHEAP_BASE_URL=https://api.groq.com/openai/v1
CHEAP_MODEL=openai/gpt-oss-20b

# OpenRouter
CHEAP_BASE_URL=https://openrouter.ai/api/v1
CHEAP_MODEL=<any tool-calling model id from openrouter.ai/models>
```

On Groq, `llama-3.1-8b-instant` was deprecated for free and dev tiers on
2026-08-16, with `openai/gpt-oss-20b` as the recommended replacement. That is
why the default is not "Llama 3 8B".

**Claude credentials:** see `UPSTREAM_AUTH_MODE` in `.env.example`.

- `passthrough` (default): the proxy holds no Anthropic secret and forwards
  whatever Claude Code sends, API key or claude.ai login.
- `inject`: the proxy holds `ANTHROPIC_API_KEY` and replaces client
  credentials. Off-loopback, `PROXY_AUTH_TOKEN` is required.

The cheap provider's key never leaves the proxy, and Anthropic credentials
are never sent to it.

## Claude Code integration

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  }
}
```

- **`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` is required for rule 6.** Without it,
  Claude Code doesn't send `x-claude-code-request-class`, and its side
  requests (titles, classifiers, summaries) get classified like any prompt.
- **With a claude.ai login,** the primary route keeps using your
  subscription. Only cheap-routed turns leave it.
- **Other clients:** point the base URL at `http://127.0.0.1:8787`. Without
  session headers, conversations are keyed by a hash of their first message.

## Before trusting it

The `route decision` log line carries the JEV distribution, the route and the
reason for every turn. Use it to measure:

- the share of turns that went cheap;
- how many of those escalated on the next human turn (a misroute signal);
- how often the cheap provider failed over.

Tune `ROUTER_MIN_CHEAP_PROBABILITY` from that data, not from intuition.
