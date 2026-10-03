# jev-router

A local, Anthropic-compatible gateway that sits between Claude Code (or any
Messages-API client) and `api.anthropic.com`. It uses **TypeSafe JEV** as a
System One classifier to route each conversation to the cheapest Claude model
that is likely to be sufficient.

```
Claude Code ──ANTHROPIC_BASE_URL──▶ jev-router :8787 ──▶ api.anthropic.com
                                       │
                                       └─(new human turn only)─▶ JEV /v1/systemone
```

## 1. Architecture

**Gateway / Router pattern.** The proxy speaks the Anthropic Messages format on
both sides. Claude Code believes it talks to Anthropic; Anthropic sees an
ordinary client. The proxy's only job is to decide the `model` field — and to
otherwise stay out of the way.

**System One vs System Two.**

| | System One (JEV) | System Two (Claude) |
|---|---|---|
| Job | *Which model is enough?* | Do the work |
| Output | Calibrated probabilities over typed answers | Text, tool calls, reasoning |
| Latency / cost | < 0.5 s, ~$0.042 / M input tokens | Seconds to minutes, $1–$10 / M input |

JEV is asked **one ordinal `score` question** whose three levels are the tiers
(haiku / sonnet / opus). The returned level distribution `p0, p1, p2` becomes
cumulative *sufficiency* scores:

```
haiku  = p0            # P(a haiku-level model is enough)
sonnet = p0 + p1
opus   = 1
```

e.g. `{ "haiku": 80, "sonnet": 95, "opus": 100 }`. A pure function
(`src/domain/policy.ts`) then picks the **cheapest tier whose score ≥
`ROUTER_THRESHOLD`**, otherwise the ceiling (fail-up). No randomness, no I/O.

### Why the router is session-sticky, not per-request

This is the decision that makes or breaks the idea, so it is explicit:

- **Prompt caches are model-scoped.** Claude Code resends the whole history on
  every agent-loop step. Switching model mid-conversation re-bills that
  history as uncached input — usually more than the cheaper model saves.
- **Thinking blocks are bound to the model and conversation.** A switch drops
  the reasoning the previous model produced.
- **Rewriting `system` / `tools` / `messages` breaks caching and the
  preserved-thinking check upstream.** The proxy never touches them.

So the rules are:

| Situation | Behaviour |
|---|---|
| Fresh conversation (1 message) or just compacted | Classify, route |
| Tool-result continuation (agent loop) | Reuse the conversation's tier, **no JEV call** |
| New human turn in an ongoing conversation | Classify; **escalate only**, never de-escalate |
| Conversation outgrows the tier's context window | Bump to the cheapest tier that fits |
| Client asked for model X | X's tier is a hard **ceiling**; same tier ⇒ X is kept verbatim (Fable stays Fable) |
| `auxiliary` / `compaction` requests | Pass through |
| JEV error / timeout | Fail open: keep the tier, else the requested model |
| Routed model returns 400/404/422 | Replay the **original bytes** on the requested model, pin the conversation there |

Conversation identity comes from Claude Code's `x-claude-code-session-id` +
`x-claude-code-agent-id` headers (so each subagent is routed independently),
falling back to a hash of the first message for generic clients.

## 2. Repository structure

```
src/
├── index.ts                      # composition root — the only file that knows concrete classes
├── config.ts                     # zod-validated env → typed Config; fails fast at boot
├── domain/                       # pure, no I/O
│   ├── tiers.ts                  # Tier, ordering, TierScores contract
│   ├── policy.ts                 # selectTier(): deterministic decision
│   └── model-catalog.ts          # per-model capabilities (context, max output, thinking, effort)
├── classifier/                   # System One port + adapters
│   ├── classifier.ts             # ComplexityClassifier interface
│   ├── jev-classifier.ts         # TypeSafe /v1/systemone adapter
│   └── heuristic-classifier.ts   # offline mock for dev/tests
├── routing/
│   ├── messages-body.ts          # minimal open-schema parsing of the Messages body
│   ├── router.ts                 # stickiness, escalation, ceiling, fail-open
│   ├── request-adapter.ts        # strip fields the cheaper model rejects
│   └── session-store.ts          # TTL + LRU map (20 lines, no dependency)
└── proxy/
    ├── server.ts                 # Fastify routes, replay-on-reject
    ├── upstream.ts               # undici byte-level forwarder (streams, no decompression)
    └── headers.ts                # hop-by-hop filtering, credential extraction
test/                             # node:test — unit + e2e against fake upstreams
```

Dependencies point inward: `proxy → routing → domain`, `routing → classifier
(interface)`. Swapping JEV for another System One model is one new file plus
one line in `index.ts`.

## 3. Dependencies

| Package | Why | Not chosen |
|---|---|---|
| `fastify` | Raw-buffer body parsing with a hard `bodyLimit`, stream replies, pino logging built in | Express: slower, no built-in structured logging |
| `undici` | `request()` returns the raw, *not decompressed* body stream — exactly what a transparent proxy must relay | `axios`/`node-fetch`: buffer or auto-decompress; global `fetch` decompresses and would desync `content-encoding` |
| `zod` | Validate env and the few body fields read, with `looseObject` so unknown fields survive | Hand-rolled guards |

Dev: `typescript`, `tsx`, `@types/node`. Tests use `node:test`.
**Not needed:** `dotenv` (Node ≥ 20.6 has `--env-file`), an LRU library, and
the Anthropic SDK — the SDK builds new requests from typed params, while a
gateway must forward unknown beta headers and body fields untouched
([Claude Code gateway contract](https://code.claude.com/docs/en/llm-gateway-protocol)).

## 4. Implementation highlights

**Proxy** (`src/proxy/server.ts`): every body is kept as a `Buffer`. If the
router keeps the requested model, the original bytes go upstream unchanged.
Only when the model changes is the body re-serialized, with `system`,
`tools` and `messages` untouched. Responses are piped as streams, so SSE events
and keep-alive pings reach Claude Code as they arrive. Unknown paths
(`/v1/models`, `HEAD /api/hello`, …) are passed through.

**JEV** (`src/classifier/jev-classifier.ts`):

```jsonc
// POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer $TYPESAFE_API_KEY
{
  "model": "jev-latest",
  "state": "Developer request to an AI coding agent:\n<prompt>\n\nContext: turn 1, 24 tools, ~31000 input tokens.",
  "questions": {
    "required_tier": {
      "type": "score",
      "instructions": "What is the least capable tier of AI coding assistant that will complete this request correctly on the first attempt?",
      "criteria": ["Trivial or mechanical…", "Standard engineering…", "Hard reasoning…"]
    }
  }
}
// → answers.required_tier.probabilities = { "0": 0.8, "1": 0.15, "2": 0.05 }
```

Only `probabilities` is consumed and it is zod-validated; anything else fails
the classification, and the router fails open.

**Request adapter** (`src/routing/request-adapter.ts`): when routing down to
Haiku 4.5 it removes `thinking: {type: "adaptive"}` and `output_config.effort`,
which Haiku 4.5 rejects, clamps `max_tokens` to 64K and drops `speed`. Without
this, Claude Code's own recovery would turn thinking off for the rest of the
conversation.

## 5. Setup

```bash
git clone https://github.com/covre81/jev-app-pc.git jev-router && cd jev-router
npm ci
cp .env.example .env          # set TYPESAFE_API_KEY (or CLASSIFIER=heuristic for offline dev)
npm test                      # unit + e2e against fake upstreams, no network
npm run build && npm start    # or: npm run dev
curl -s localhost:8787/healthz
```

Requirements: Node ≥ 22.19.

**Credentials:**

- **`passthrough`** (default): the proxy holds no Anthropic secret. Claude Code
  sends its own API key or claude.ai login, and the proxy forwards it.
- **`inject`**: set `ANTHROPIC_API_KEY` in `.env`. The proxy strips client
  credentials and injects the key. If `HOST` is not loopback,
  `PROXY_AUTH_TOKEN` is required, because otherwise the proxy is an open relay
  to your bill.

**OpenRouter:** not used. JEV's interface is TypeSafe's typed
`/v1/systemone` endpoint, not chat completions. Pointing `JEV_API_URL` at
another host only works if it serves that same contract.

## 6. Claude Code integration

`~/.claude/settings.json` (or the project's `.claude/settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  }
}
```

Or per shell: `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 claude`.

- `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` makes Claude Code send
  `x-claude-code-request-class`, so titles, summaries and compaction are not
  classified. It is off by default for custom base URLs.
- In `inject` mode, also set `"ANTHROPIC_AUTH_TOKEN": "<PROXY_AUTH_TOKEN>"`.
- **Billing reality:** with a claude.ai subscription login and no gateway
  credential, requests still bill against the subscription. Routing then saves
  usage-limit quota, not money. Per-token savings only exist on API-key billing.
- The `/model` you pick is the **ceiling**. Pick Opus to let the router use
  the full range, or Sonnet to cap spend.
- Claude Code keeps displaying the requested model. The model actually used is
  in the `x-jev-route` response header and in the `route decision` log line.

Other Messages-API clients: point their base URL at `http://127.0.0.1:8787`.
Without session headers, conversations are keyed by a hash of their first message.

## Limitations — read before trusting the savings

1. **The first-turn classification is a prior, not ground truth.** In agentic
   coding, difficulty often shows up only after tool results come back. The
   escalate-on-new-human-turn rule only partly covers this.
2. **Measure before you believe it.** Anthropic's guidance is to compare a
   cascade against the simpler alternative: the strongest model at lower
   effort (`/effort low` on Opus). One model also means one cache namespace.
   Use the `route decision` logs (`scores`, `tier`, `reason`) to build an eval
   before you raise the threshold or drop it.
3. **Session state is in memory.** After a restart, ongoing conversations are
   treated as running on the requested model. This is safe, but you lose the
   savings until the next fresh conversation.
4. **`model-catalog.ts` is a static table** (as of 2026-09). New models fall
   back to a permissive profile plus the replay-on-reject path. Update the table
   when you add a model.
5. **JEV's response schema is pinned to `answers.<id>.probabilities`.** That
   shape matches TypeSafe's published score examples. If TypeSafe changes it,
   zod rejects the response and the router fails open: you lose savings, not
   correctness.
