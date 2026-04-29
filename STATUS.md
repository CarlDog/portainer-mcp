# Status

**Last updated:** 2026-04-28

## Phase

Deployed and verified — running on the NAS at
`http://carldog-nas:3004/mcp`, returning live stack data via
`portainer_list_stacks`. Full chain proven (dev machine → HTTP → MCP
session → PortainerClient → host.docker.internal:9443 → Portainer).

## Done

- Repo initialized with TypeScript + MCP SDK + PortainerClient
- 7 read-only tools registered:
  - `portainer_list_endpoints`
  - `portainer_list_stacks` (optionally filtered by endpoint)
  - `portainer_get_stack` (by ID)
  - `portainer_list_containers` (per endpoint, optional all=true)
  - `portainer_get_container` (by ID/name)
  - `portainer_container_logs` (1-5000 line tail)
  - `portainer_system_status`
- Auth via `PORTAINER_URL` + `PORTAINER_API_KEY` env vars (X-API-Key
  header). Optional `PORTAINER_VERIFY_TLS=false` for self-signed certs.
- Dual transport: stdio (default) + Streamable HTTP (when `MCP_PORT` set)
- Multi-stage Dockerfile (alpine, non-root user `mcp`)
- `docker-compose.yml` for Portainer/Compose deployment (HTTP, port
  `${HOST_PORT:-3004}:3000`)
- Security baseline: `.gitignore`, `.gitleaks.toml`, `.githooks/pre-commit`
  (gitleaks + PII pattern scan from the start)
- VS Code workspace config (settings, extensions, launch, tasks,
  `.code-workspace`) and ESLint + Prettier
- GitHub Actions: `docker-publish.yml` (multi-arch GHCR) and `test.yml`
  (typecheck/build matrix + lint/format quality job)
- Project docs: CLAUDE.md, STATUS.md, README.md

## Done (post-scaffold)

- `npm install` + tsc + lint + format all clean. SDK + undici + zod +
  express resolved cleanly.
- Public repo published at https://github.com/CarlDog/portainer-mcp
  with a no-PII commit author.
- Smoke-tested HTTP transport locally: `/health` 200, MCP initialize
  + `portainer_list_endpoints` + `portainer_list_stacks` all returned
  real Portainer data.
- Added `extra_hosts: host.docker.internal:host-gateway` to compose so
  the deployed container can reach the host's Portainer on 9443.
- Deployed to the NAS via Portainer API (stack id 129). Container
  pulls `ghcr.io/carldog/portainer-mcp:latest`, runs HTTP transport
  on host port 3004 → container 3000.
- Verified deployed instance end-to-end: `tools/call portainer_list_stacks`
  via `http://carldog-nas:3004/mcp` returns all 36 stacks including
  itself.
- Serena project activated with five memories
  (`project_overview`, `structure`, `suggested_commands`, `conventions`,
  `task_completion`). Memories are workstation-neutral.
- OpenChronicle registered local-scope for this directory.

## Next

- **Fix the secrets-leak before anything else.** See Known Gaps —
  `PortainerClient` needs to redact env values whose keys match a
  secrets pattern before returning. Audit `portainer_get_container`
  for the same issue while patching (Docker inspect also surfaces
  container env via `Config.Env`). This is a security-blocker for
  any further use of the read tools against environments with real
  credentials.
- Decide on the next batch of tools. Most likely candidates:
  `portainer_redeploy_stack` (PUT /api/stacks/{id}/git/redeploy or
  PUT /api/stacks/{id}), `portainer_container_restart`,
  `portainer_container_stop`, `portainer_container_start`. These are
  write operations; treat as a separate, focused commit per the
  CLAUDE.md "write operations" guidance.
- Add tests once a real Portainer test target is set up.
- Consider a `portainer_deploy_stack` tool that wraps the
  string-based deploy we used by hand. Self-bootstrapping potential.

## Open Decisions

None active. Decisions made during scaffolding:

- **Read-only first:** matches the pattern from plex-mcp, servarr-mcp,
  and downloader-mcp. Write tools (deploy/restart/etc.) are higher
  blast-radius and added after smoke tests.
- **API key over username/password:** simpler, revocable, no JWT
  refresh. User generates in Portainer UI.
- **Self-signed cert opt-out:** `PORTAINER_VERIFY_TLS=false` opts in
  to skip TLS verification, defaulting to verify. Most home setups
  will set this to false.
- **No Portainer client SDK:** raw `fetch`. Same reasoning as plex-mcp
  and friends — small surface, fewer transitive deps, the Portainer
  REST API is straightforward.
- **HTTP transport from day one:** unlike the earlier MCPs (which
  added HTTP later), portainer-mcp ships dual-transport from the start
  since the pattern is now proven.

## Known Gaps

- **[SECURITY — high priority] Secrets leak in `portainer_list_stacks`
  and `portainer_get_stack`.** The Portainer API returns each stack's
  full `Env` array with values in plaintext. The current `PortainerClient`
  forwards the response verbatim, so calling either tool exposes every
  stack's API keys, passwords, and bearer tokens to the MCP caller —
  the LLM, anyone who can hit the MCP endpoint, anything that logs
  tool outputs. Confirmed empirically on 2026-04-29: a single
  `portainer_list_stacks` call returned the live values for
  `PLEX_TOKEN`, every Servarr `*_API_KEY`, `QBITTORRENT_PASSWORD`,
  and `PORTAINER_API_KEY` itself.

  **Fix:** at the client layer (`PortainerClient`), redact env values
  whose **keys** match a secrets pattern — default regex
  `(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$)`.
  Replace the value with `<redacted>` before returning; never alter
  the key. Apply once at the client so every tool benefits.

  **Scope of audit:** the same leak almost certainly affects
  `portainer_get_container` — Docker `inspect` returns `Config.Env`
  in plaintext via the same proxy. Patch and test both endpoints in
  the same change. Add a regression test covering at least
  `/api/stacks`, `/api/stacks/{id}`, and the container-inspect proxy
  path once a test setup exists.

  Tracked here in lieu of a GitHub issue; promote to a real issue
  before opening the work if you'd prefer that workflow.
- Container logs are returned raw — Docker's stream multiplexing
  prefix bytes are NOT stripped. Readable for the LLM but ugly. Could
  parse and clean if it proves to be a problem.
- API key from `.env` is the only auth path. For multi-Portainer setups
  this would need to be revisited, but single-instance is the v1 target.
- No tests yet.
