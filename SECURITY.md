# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues, discussions or pull requests.

Report them privately through GitHub's private vulnerability reporting:
open the repository's **Security** tab and click **Report a vulnerability**.
Include a description of the issue, steps to reproduce, the affected version
or commit, and the impact you expect.

You should receive an acknowledgement within a few days. Please allow a
reasonable amount of time for a fix before disclosing the issue publicly.

## Supported versions

Only the latest commit on `main` is supported with security fixes.

## Scope and threat model

jev-router is a local gateway that sits between Claude Code (or another
Anthropic-compatible client) and the upstream providers, so it handles
sensitive material:

- **Credentials.** In the default `passthrough` mode it forwards the client's
  own Anthropic credential (API key or claude.ai login) without storing it.
  In `inject` mode it holds `ANTHROPIC_API_KEY`. It also holds the cheap
  provider key (`CHEAP_API_KEY`) and the TypeSafe JEV key
  (`TYPESAFE_API_KEY`) from `.env`.
- **Prompts and code.** Requests contain your prompts and source code; the
  cheap route and the JEV classifier send (part of) them to third-party
  services.
- **Network exposure.** The proxy binds to loopback (`HOST=127.0.0.1`) by
  default. Binding to another interface in `inject` mode requires
  `PROXY_AUTH_TOKEN`; anything that lets a non-local client use the proxy's
  credentials, bypass that token, or read another client's traffic is in
  scope.

Reports about leaking credentials or prompts into logs, telemetry
(`telemetry.db`) or error messages, request smuggling or header injection
toward the upstreams, and auth bypass are especially welcome.
