# Security Policy

## Supported Versions

Only the latest release (tracked by the `latest` tag on
[`ghcr.io/carldog/portainer-mcp`](https://github.com/CarlDog/portainer-mcp/pkgs/container/portainer-mcp))
receives security fixes. There is no LTS branch.

## Reporting a Vulnerability

Please report security issues privately using GitHub's
[Security Advisories](https://github.com/CarlDog/portainer-mcp/security/advisories/new)
for this repository, rather than opening a public issue. This applies to
anything with real impact — secret leakage (e.g. a gap in the response
redactor documented in [CLAUDE.md](CLAUDE.md)), an auth bypass on the
HTTP transport, or a way to trigger a destructive write tool without its
intended confirmation gate.

Expect an initial response within a few days. This is a solo-maintained
project — there's no formal SLA, but reports are taken seriously and
fixes for confirmed issues are prioritized over other work.

## Scope Notes

- This server is designed to run with an **admin-scoped Portainer API
  key** (see [CLAUDE.md](CLAUDE.md) "Self-signed certs" and the
  Docker-proxy notes in [docs/PORTAINER-API.md](docs/PORTAINER-API.md)).
  That's a deliberate trust boundary, not a bug — whoever controls this
  server's environment already has the same reach as whoever holds that
  key.
- A handful of tools accept credentials as input (`portainer_set_git_auth`,
  `portainer_create_git_stack`, `portainer_convert_stack_to_git`) — see
  CLAUDE.md's "Secrets in tool INPUTS, not just outputs" for the accepted
  trade-off and why this isn't itself a vulnerability report.
- Known, already-documented gaps (e.g. secrets inlined directly in a
  compose file rather than referenced via `${VAR}` aren't redacted) are
  tracked in [STATUS.md](STATUS.md)'s "Known Gaps" section — check there
  before filing a duplicate report.
