# Status

**Last updated:** 2026-04-29

## Phase

Deployed and verified — running on the NAS at
`http://your-nas:3004/mcp`, returning live stack data via
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
  via `http://your-nas:3004/mcp` returns all 36 stacks including
  itself.
- Serena project activated with five memories
  (`project_overview`, `structure`, `suggested_commands`, `conventions`,
  `task_completion`). Memories are workstation-neutral.
- OpenChronicle registered local-scope for this directory.
- **Secrets-leak fix landed in `PortainerClient`.** Generic
  `redactSecrets` walker runs once on every JSON response inside
  `request<T>()`. Recursively descends the response tree; any
  property literally named `Env`/`env` (case-insensitive) whose
  value is an array gets scrubbed. Handles both shapes: Portainer's
  `[{Name, Value}, …]` (stacks) and Docker inspect's
  `["KEY=VALUE", …]` (`Config.Env`). Key-pattern regex is the one
  STATUS specified:
  `(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$)`
  — values get replaced with `<redacted>`, keys are never altered.
  Covers `portainer_list_stacks`, `portainer_get_stack`, and
  `portainer_get_container` in one place; any future tool added at
  the client layer inherits the protection. `containerLogs`
  returns text not JSON, so the walker doesn't run on it (logs are
  app-controlled output, not config — separate concern).
  **Verified live** against the NAS deployment 2026-04-29 — every
  secret-pattern Env value across all 36 stacks now returns
  `<redacted>` and every non-secret value passes through unchanged.
- **Architectural redaction invariant documented in CLAUDE.md.**
  The redactor lives in `request<T>()`; any new client method that
  bypasses it and calls `fetch` directly skips redaction silently.
  The CLAUDE.md note flags this so future write tools (which need
  raw env for round-trip) must route through a deliberate opt-out
  (the planned `noRedact: true` flag) rather than a parallel fetch.
- **Portainer API reference doc published.**
  [`docs/PORTAINER-API.md`](docs/PORTAINER-API.md) catalogs the API
  surface for Portainer CE 2.39.1 (the version on the NAS) — auth,
  resource model, cross-cutting patterns, gotchas, endpoints in use,
  endpoints we haven't built yet (with risk class), and explicit
  out-of-scope. Pinned spec snapshot at
  [`docs/specs/portainer.json`](docs/specs/portainer.json) (Swagger
  2.0, 441 KB, 185 paths). Follows the
  plex-mcp / servarr-mcp convention. Three things the research
  surfaced that change earlier assumptions:
  - Stack deploys are **synchronous** in 2.39.1 (the older
    `go stackDeploy(...)` async pattern is gone). PUT blocks until
    containers are recreated. Self-redeploy of portainer-mcp itself
    will appear to fail because the in-flight HTTP fetch sees a
    connection drop mid-redeploy.
  - The Env round-trip wipe trap affects **three** update endpoints,
    not just one: `PUT /api/stacks/{id}`, `POST /api/stacks/{id}/git`,
    `PUT /api/stacks/{id}/git/redeploy`.
  - `POST /containers/{id}/recreate` is a Portainer-specific
    endpoint that does pull-and-recreate for a single container —
    likely cleaner than the stack-redeploy round-trip dance for
    some use cases.
- **First write tool landed: `portainer_redeploy_stack`.** Wraps
  the file-based redeploy (`PUT /api/stacks/{id}`) for Compose and
  Swarm stacks. Implements the env round-trip via the new
  `noRedact: true` opt-out on `request<T>()` — internal GET fetches
  the raw stack + raw file content, the PUT echoes them back with
  `repullImageAndRedeploy: true` (the non-deprecated form per
  Portainer 2.36+). Refuses git-managed stacks at the client layer
  (would silently detach from git via `stack.GitConfig = nil`) and
  refuses Kubernetes stacks (different endpoint required). Tool
  schema requires `confirm: true` (z.literal) as a forcing function
  so the LLM has to acknowledge the destructive intent in its tool
  call. Tool description warns that self-redeploy of portainer-mcp
  appears to fail because the in-flight HTTP fetch sees a
  connection drop mid-redeploy (the redeploy itself still
  succeeds).

## Next

- **Bootstrap the new image onto the NAS.** The `portainer_redeploy_stack`
  tool only exists on the new image; the deployed `latest` is the
  previous build. First redeploy must still happen via Portainer UI
  ("Pull and redeploy" → "Re-pull image" + "Force redeploy"). After
  that, all future redeploys can use the new tool.
- **Smoke-test against a safe target.** Call
  `portainer_redeploy_stack({ stack_id: 103, confirm: true })` (the
  `flaresolverr` stack — empty Env, low blast radius). Confirm the
  call succeeds, the new container comes up, and Env values stay
  intact (run `portainer_get_stack` afterward — should still return
  `Env: []`, not wiped or mangled).
- **Add the git-stack redeploy variant** (`PUT /api/stacks/{id}/git/redeploy`).
  Different endpoint, same wipe trap, similar tool shape. None of
  the user's 36 stacks are git-managed today, so this is lower
  priority — still worth shipping for completeness.
- **Container lifecycle tools** (`restart`, `stop`, `start`, `kill`)
  are pure Docker proxy passthroughs per the API doc — small
  follow-up commit. No round-trip / no `noRedact` needed.
- **Consider `portainer_recreate_container`** wrapping
  `POST /containers/{id}/recreate` (Portainer-specific endpoint).
  Cleaner than stack-redeploy for "update one service's image"
  workflows. See PORTAINER-API.md. Most likely candidates:
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

- **Inline secrets in compose YAML are not redacted.**
  `portainer_get_stack` returns `StackFileContent` — the raw compose
  file string. The redactor only scrubs structured `Env` arrays, not
  arbitrary YAML. If a user inlines a secret directly in a compose
  file (e.g. `environment: [PASSWORD=hunter2]` instead of `${PASSWORD}`
  + a stack-env reference), `portainer_get_stack` will still surface
  it. Mitigation is to use `${VAR}` references in compose and put the
  value in stack-level env vars, which is the recommended Portainer
  pattern and what the redactor covers. Reliable YAML scrubbing is a
  much bigger lift; deferring until there's a concrete need.
- Redaction is **key-based, not value-based.** A high-entropy string
  stored under a key that doesn't match the pattern (e.g. `BUILD_ID`,
  `INSTANCE_ARN`) is still passed through. This is intentional —
  matching by value would have to choose between aggressive heuristics
  (false positives on long IDs/UUIDs) or ML-style entropy (overkill).
  Known acceptable trade-off for v1.
- No regression test for the redactor yet. Add when test infra
  lands; the cases to cover are `/api/stacks`, `/api/stacks/{id}`,
  and the container-inspect proxy path
  (`/api/endpoints/{id}/docker/containers/{id}/json`).
- Container logs are returned raw — Docker's stream multiplexing
  prefix bytes are NOT stripped. Readable for the LLM but ugly. Could
  parse and clean if it proves to be a problem.
- API key from `.env` is the only auth path. For multi-Portainer setups
  this would need to be revisited, but single-instance is the v1 target.
- No tests yet.
