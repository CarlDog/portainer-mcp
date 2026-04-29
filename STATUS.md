# Status

**Last updated:** 2026-04-28

## Phase

Scaffolding — initial repo structure created with HTTP transport from
the start. Pending build verification + smoke test against a real
Portainer instance.

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

## Next

- `npm install` + `tsc` clean. Verify SDK + undici resolve.
- Smoke-test the HTTP transport: `MCP_PORT=3004 npm run dev` against
  the real Portainer at `https://your-nas:9443`. Hit `/mcp` with
  the MCP Inspector or curl, verify `portainer_list_stacks` returns
  the expected stack list.
- Smoke-test stdio path post-build.
- Commit + push to GitHub (under CarlDog, public, no-PII commit author).
- Configure Serena project + onboarding memories.
- Register OpenChronicle MCP locally for this directory.
- Deploy to the NAS via Portainer (using the existing deploy script —
  it'd be a fun bootstrap to use portainer-mcp itself for this once
  it's deployed, but for the first deploy we use the script).
- Once deployed, decide on the next batch of tools — most likely
  candidates: `portainer_redeploy_stack`, `portainer_container_restart`.
  These are write operations and warrant a more conservative rollout.

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

- No tests yet.
- No published Docker image yet (will publish on first push to main).
- Container logs are returned raw — Docker's stream multiplexing
  prefix bytes are NOT stripped. Readable for the LLM but ugly. Could
  parse and clean if it proves to be a problem.
- API key from `.env` is the only auth path. For multi-Portainer setups
  this would need to be revisited, but single-instance is the v1 target.
