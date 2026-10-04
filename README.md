# jev-router

A local, Anthropic-compatible gateway for Claude Code (or any Messages-API
client) that uses **TypeSafe JEV** as a System One classifier to keep simple
work off your Claude quota.

- **Simple work** goes to a cheap OpenAI-compatible provider: Ollama Cloud
  (default, free plan), Groq or OpenRouter.
- **Structural work** goes to Anthropic.

```
                                      ┌─ simple ───▶ Ollama Cloud / Groq / OpenRouter  (/chat/completions, translated)
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
| `cheap` | Any OpenAI-compatible API (default: Ollama Cloud `gpt-oss:20b-cloud`) | Free plan with usage limits, or per token on Groq/OpenRouter | JEV level 1, the simple tasks: questions, explanations, one-file edits, renames, docstrings |
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
     the conversation is pinned to primary, and Claude Code retries (2.1.289
     re-sends the turn as a non-streaming request). The pin does not cover a
     break on a conversation's first turn: that retry is re-classified.
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
├── cli.ts                         # `jev-router` binary: serve | stats | help; env-file loading
├── serve.ts                       # composition root (only file that knows concrete classes)
├── config.ts                      # zod-validated env → typed Config; fails fast at boot
├── paths.ts                       # ~/.jev-router (or $JEV_ROUTER_HOME): .env + telemetry.db
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
├── proxy/
│   ├── server.ts                  # Fastify routes, failover in both directions
│   └── headers.ts                 # hop-by-hop filtering, credential extraction
└── telemetry/                     # cost audit; can never fail or slow a response
    ├── schema.ts                  # `router_logs` row type, SQL migrations, insert
    ├── db.ts                      # better-sqlite3 + WAL, applies migrations on boot (user_version)
    ├── usage-meter.ts             # taps the relayed body (SSE/JSON, gzip/br) for `usage`
    ├── audit.ts                   # one row per exchange, recorded after the socket closes
    ├── recorder.ts                # TelemetrySink port; queued, batched SQLite writes
    └── stats.ts                   # aggregates + table for `jev-router stats`
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
| `better-sqlite3` | Local SQLite file for the cost audit. One table, plain SQL; migrations are an append-only list applied on boot. **Held at `^12`:** v13 ships no prebuilt binaries and needs a C++ toolchain (MSVC) to install on Windows |

Deliberately absent:

- `dotenv`: `process.loadEnvFile` does the job.
- The Anthropic SDK: a gateway forwards bytes, it doesn't build requests.
- The OpenAI SDK: two endpoints and a stream translator don't justify it.
- An LRU library.
- An ORM: one table, a handful of queries.

## Setup

```bash
git clone https://github.com/covre81/jev-app-pc.git jev-router && cd jev-router
npm ci
cp .env.example .env
#   TYPESAFE_API_KEY=...   (or CLASSIFIER=heuristic for offline dev)
#   Ollama Cloud (default): `ollama signin && ollama pull gpt-oss:20b-cloud`, no key
#   Groq / OpenRouter: set CHEAP_BASE_URL, CHEAP_MODEL and CHEAP_API_KEY (see presets)
npm test                   # fake upstreams, no network
npm run build && npm start
curl -s localhost:8787/healthz
```

Requires Node ≥ 22.19.

### Global CLI (`npm link`)

```bash
cd jev-router
npm ci                     # also builds dist/ (prepare script)
npm link                   # puts `jev-router` on your PATH
mkdir -p ~/.jev-router && cp .env.example ~/.jev-router/.env   # then fill in the keys
jev-router serve           # start the gateway (default command)
jev-router stats           # cost audit, from any directory
jev-router stats --since 24h
jev-router stats --json
```

Env lookup order: variables already set in the shell, then `--env <file>`,
then `./.env`, then `~/.jev-router/.env`. `JEV_ROUTER_HOME` moves the
`~/.jev-router` directory. After `git pull`, run `npm run build` again; the
link points at this checkout, so nothing else needs reinstalling.

**Cheap provider presets:**

```bash
# Ollama Cloud via the local daemon (default, free plan)
CHEAP_BASE_URL=http://127.0.0.1:11434/v1
CHEAP_API_KEY=ollama
CHEAP_MODEL=gpt-oss:20b-cloud

# Groq
CHEAP_BASE_URL=https://api.groq.com/openai/v1
CHEAP_MODEL=openai/gpt-oss-20b

# OpenRouter
CHEAP_BASE_URL=https://openrouter.ai/api/v1
CHEAP_MODEL=<any tool-calling model id from openrouter.ai/models>
```

Ollama Cloud runs the model on ollama.com: the prompt, including your code,
leaves the machine, and the free plan has usage limits. When a limit is hit
the request fails before the first byte and the router falls back to
Anthropic. A local model (`qwen2.5:14b`, `llama3.1`) keeps everything on the
machine but is much slower on CPU; run `bench.ts` before choosing it.

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

## Telemetry and cost audit

Every `/v1/messages` exchange is written to `~/.jev-router/telemetry.db`
(table `router_logs`, override with `TELEMETRY_DB_PATH`, disable with
`TELEMETRY_ENABLED=false`).

| Column | Meaning |
|---|---|
| `session_id` | Conversation key: `<x-claude-code-session-id>:<agent>`, or a hash of the first message |
| `human_prompt_hash` | sha256 of the human-typed text; null on tool-result turns. Equal hashes = repeated prompt |
| `jev_decision` | JSON `{simple, standard, structural, pSimple, pComplex, classifierMs}`; `pComplex` is level 3. Null when JEV was not asked (sticky turns, auxiliary requests) |
| `final_provider` | `anthropic` or `openai` (the cheap OpenAI-compatible provider) |
| `tokens_in` / `tokens_out` | From the response `usage`; `tokens_in` includes cache reads and writes |
| `cache_read_tokens` | Part of `tokens_in` served from the Anthropic prompt cache |
| `latency_ms` | Request received → last byte sent to the client |
| `fallback_triggered` | The cheap provider failed before answering and Anthropic served the request |
| `outcome` | `ok`, `http_error`, `stream_error`, `client_abort` or `proxy_error` |

**Why it adds no latency.** The response body passes through a tap that
copies nothing and only scans `data:` lines that mention `usage` or `error`.
Compressed bodies are decoded on a side channel. The row is built after the
client socket closes, then pushed to an in-memory queue. A timer writes the
queue to SQLite once a second, in one transaction. If a write fails, the rows
stay queued and the response is unaffected.

**`jev-router stats`** prints the total requests, how many were diverted from
Anthropic, fallbacks, repeated prompts, tokens per provider and the
**net cost in dollars**, which says whether routing is making or losing money.

The net cost is measured against a **baseline**: the same traffic sent to
Anthropic with a warm prompt cache. For each turn, the history the previous
turn already sent is billed as a cache read, and only the new tokens are
billed as a cache write.

| Line | How it is computed |
|---|---|
| Gross savings | For each request the cheap provider served: warm Anthropic cost minus cheap cost |
| Cache-miss penalty | First Anthropic request after a cheap one (escalation or fallback): actual cost minus warm cost. Anthropic re-reads the whole history at full input + write price because the cheap turns broke the cache |
| Failed cheap attempts | Tokens billed by the cheap provider on requests that then fell back |
| **NET** | baseline − (actual Anthropic + actual cheap). Positive = **PROFIT**, negative = **LOSS** |

Prices: Anthropic list prices per model (built-in table, override with
`PRIMARY_PRICE_*`). The cheap provider price defaults to $0, which is right
only for a local model; set `CHEAP_PRICE_INPUT_PER_MTOK` and
`CHEAP_PRICE_OUTPUT_PER_MTOK` for Groq or OpenRouter, otherwise `stats` warns.
On a Claude subscription the dollars are API-equivalent quota, not a bill.

Known limits:

- the cheap model's tokenizer is not Claude's, so its token counts are only
  close to what Anthropic would have counted;
- rows logged before the `cache_write_tokens` column existed are priced as if
  they had no cache writes;
- requests whose response carried no `usage` are counted and reported, but
  priced at $0.

Before tuning `ROUTER_MIN_CHEAP_PROBABILITY`, use the database to measure:

- the share of turns that went cheap;
- how many of those escalated on the next human turn (a misroute signal);
- how often the cheap provider failed over.

```sql
-- conversations that used both providers (escalated or failed over)
SELECT session_id FROM router_logs GROUP BY session_id
HAVING min(final_provider) = 'anthropic' AND max(final_provider) = 'openai';
```

## Checks against real APIs (local only)

CI runs only the offline suite (`npm test`: every upstream is a local fake).
Three scripts call real services and are meant to be run by hand. Both read the
same env files as the CLI (`--env <file>`, else `./.env`, else
`~/.jev-router/.env`).

**JEV contract**: one `POST /v1/systemone` with a minimal prompt. Prints the
raw body, then checks it strictly against the adapter's schema (levels
`0`/`1`/`2` present, summing to 1). Exit 0 = contract holds.

```bash
npx tsx scripts/test-jev-real.ts
```

**Cheap-model tool benchmark**: runs Read/Edit tasks (fix a bug, rename across
two files, read a value) through the real `OpenAICompatibleProvider`, in an
in-memory workspace with Claude Code's tool shapes and rules (absolute paths,
read before edit, unique `old_string`, unknown parameters rejected). Each
trial ends as:

| Outcome | What the router would see |
|---|---|
| `success` | Task verified |
| `wrong_result` / `max_steps` | Protocol fine, work wrong: silent quality loss |
| `fallback` | Refused before the first byte: the turn goes to Anthropic |
| `stream_error` | Stream broke after it started (e.g. invalid tool JSON): the client gets an `error` event and Claude Code retries; the retry goes to Anthropic, except on a conversation's first turn, where it is re-classified (ADR rule 4) |
| `truncated` | `max_tokens` or refusal |

```bash
npx tsx scripts/bench.ts --trials 5 --pad-kb 32
npx tsx scripts/bench.ts --task rename --model llama3.1:latest --json
```

`--pad-kb` grows the system prompt toward Claude Code's real context size.
Exit 0 when the success rate reaches `--min-success` (default 0.8).

**Anthropic passthrough smoke**: two small calls through the real
`AnthropicProvider` in `inject` mode (needs `ANTHROPIC_API_KEY`). Checks a
streamed turn (HTTP 200, `text/event-stream`, `anthropic-ratelimit-*` and
`request-id` forwarded, `message_start` ... `message_stop` in order, with
`accept-encoding` as Claude Code sends it) and that an upstream 4xx reaches the
client as Anthropic's own JSON error. Exit 0 = all checks pass.

```bash
npx tsx scripts/smoke-anthropic.ts --model claude-haiku-4-5
```

Groq and OpenRouter are both OpenAI-compatible: point `CHEAP_BASE_URL` /
`CHEAP_API_KEY` / `CHEAP_MODEL` at either one and run `bench.ts`, which already
streams through the real SSE translation.

### Bench history

Run `npx tsx scripts/bench.ts --trials 5 --pad-kb 32` before changing `CHEAP_MODEL`, and add a row.

| Date | Model | Trials | Success | Provider failures | Avg trial | Notes |
|---|---|---|---|---|---|---|
| 2026-10-04 | `gpt-oss:20b-cloud` | 15 (pad 32 KB, 12 steps) | 93% | 7% (1 `stream_error`) | 6.7 s | 25 schema errors, mostly `Read` with `offset: 0`. A separate 45-trial capture: 0 `stream_error`, 1 `rename` `wrong_result` (import not updated). |
