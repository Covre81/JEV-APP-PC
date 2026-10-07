# Contributing to jev-router

Thanks for your interest in improving jev-router. Bug reports, eval cases and
pull requests are all welcome.

## Getting started

Requirements: Node.js >= 22.19 (CI runs Node 22 and 24) and npm.

```bash
npm ci              # installs dependencies and builds dist/ (prepare script)
npm run typecheck   # tsc --noEmit
npm test            # offline suite, fake upstreams, no network
```

Copy `.env.example` to `.env` only if you want to run the proxy locally
(`npm run build && npm start`). The test suite does not need it.

## Tests

- The suite in `test/` must stay **offline**: every upstream (Anthropic, the
  cheap OpenAI-compatible provider, TypeSafe JEV) is a local fake server.
  Do not add tests that call real APIs.
- Checks against real APIs live in `scripts/` (`smoke-anthropic.ts`,
  `test-jev-real.ts`, `eval-jev.ts`, `bench.ts`), are run by hand, and never
  run in CI.
- Add or update tests for every behavior change. Routing rules are tested
  without HTTP (`test/policy.test.ts`, `test/router.test.ts`); proxy behavior
  end to end in `test/proxy.e2e.test.ts`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/), as in the
  existing history: `feat(routing): ...`, `fix(statusline): ...`,
  `test(...)`, `refactor(...)`, `chore(...)`, `docs(...)`.
- Keep each commit focused; explain the *why* in the body when it is not
  obvious.
- Open pull requests against `main`. CI (`.github/workflows/ci.yml`) runs
  `npm ci`, `npm run typecheck` and `npm test` on Ubuntu and Windows with
  Node 22 and 24, and must be green before merge.
- Update `README.md` when you change configuration, CLI commands or routing
  behavior.

## Never commit

- `.env` or any `.env.*` file other than `.env.example`
- API keys, tokens or credentials of any kind
- Telemetry databases (`*.db`, e.g. `~/.jev-router/telemetry.db`)
- `scripts/eval-jev.local.json` (real-traffic eval cases may contain private
  prompts)
- Local tool state such as `.claude/`, `.cursor/` or `graphify-out/`

If you accidentally commit a secret, rotate it immediately and say so in the
pull request; removing it in a later commit is not enough.

## Design notes

Internal planning and design notes are kept privately and are not part of
this repository; the README's "Routing model (ADR)" section is the public
reference for the adopted design.

## Security issues

Please do not open public issues for vulnerabilities. See
[SECURITY.md](SECURITY.md).
