# Status

**Last updated:** 2026-04-29

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
- **First write tool landed and verified: `portainer_redeploy_stack`.**
  Wraps the file-based redeploy (`PUT /api/stacks/{id}`) for
  Compose and Swarm stacks. Implements the env round-trip via the
  new `noRedact: true` opt-out on `request<T>()` — internal GET
  fetches the raw stack + raw file content, the PUT echoes them
  back with `repullImageAndRedeploy: true` (the non-deprecated form
  per Portainer 2.36+). Refuses git-managed stacks at the client
  layer (would silently detach from git via `stack.GitConfig = nil`)
  and refuses Kubernetes stacks (different endpoint required). Tool
  schema requires `confirm: true` (z.literal) as a forcing function.
  Tool description warns that self-redeploy of portainer-mcp
  appears to fail because the in-flight HTTP fetch sees a
  connection drop mid-redeploy (the redeploy itself still
  succeeds). Verified end-to-end against the live NAS 2026-04-30:
  empty-Env smoke test (flaresolverr id 103) and live-secrets test
  (downloader-mcp id 128) both passed — round-trip preserves real
  env values, confirmed visually via Portainer UI.
- **Container lifecycle tools landed:** `portainer_container_start`,
  `portainer_container_stop`, `portainer_container_restart`,
  `portainer_container_kill`. Pure Docker-proxy passthroughs to
  `POST /api/endpoints/{id}/docker/containers/{id}/<action>`. Stop
  and restart accept `?t=N` for graceful-SIGTERM-before-SIGKILL
  timeout. Kill accepts `?signal=` and requires `confirm: true`
  (small but real risk of corrupting state mid-write since it
  skips graceful shutdown).
- **Git-stack redeploy + container recreate landed:**
  `portainer_redeploy_git_stack` (`PUT /api/stacks/{id}/git/redeploy`)
  and `portainer_recreate_container`
  (`POST /api/docker/{id}/containers/{id}/recreate`). The git
  redeploy uses the same `noRedact` round-trip pattern as the
  file-based variant but extends the round-trip to cover several
  additional wipe traps surfaced during this batch: omitting
  `RepositoryReferenceName` blanks the git ref, omitting `Prune`
  resets to false on Swarm, and the saved git password requires
  sending an empty `RepositoryPassword` to be preserved.
  `recreate_container` is a Portainer-native composition (NOT a
  Docker proxy passthrough) that pulls the image, stops + removes
  the old container, and recreates with the same Config +
  HostConfig — much cleaner than stack-redeploy for "fix one
  service after pushing a new image" workflows. The path is
  `/api/docker/{id}/...` not `/api/endpoints/{id}/docker/...`;
  earlier PORTAINER-API.md doc had this wrong (now corrected).
- **GitHub Actions bumped across all 5 MCP repos** to the current
  latest majors. Beat the June 2 2026 Node 20 force-upgrade.
- **Stack create + delete landed:** `portainer_create_stack`
  (`POST /api/stacks/create/standalone/string?endpointId=N`) and
  `portainer_delete_stack` (`DELETE /api/stacks/{id}?endpointId=N`).
  Closes the gap noted in another session — initial stack creation
  no longer requires the Portainer UI; portainer-mcp is now fully
  self-bootstrapping for file-based Compose stacks. `create_stack`
  pre-flights with a name-collision check across all stacks on the
  target endpoint (catches Portainer's silent same-name Swarm-stack
  deletion trap; refuses overwrites). `delete_stack` uses two-factor
  confirmation: caller supplies both `confirm: true` AND
  `confirm_name` matching the stack's actual Name — catches
  "wrong stack id" disasters where the LLM picked the wrong number.
  Both tools require `confirm: true`. Endpoint id for delete is
  derived from the stack record (no need to expose it as input).
- **`recreate_container` quirk fixed:** the Portainer recreate
  endpoint 500s with "endpoint not found" if given a container
  name (or any short ID) — its internal network-disconnect step
  requires the canonical 64-char Docker ID. `recreateContainer`
  now does an inspect-first to resolve any caller-provided ref
  to the full ID before calling recreate. ~50ms extra latency,
  but the tool now Just Works regardless of input shape.
  PORTAINER-API.md gotcha section documents both this quirk and
  the cosmetic `-old` Name suffix that Portainer leaves on the
  recreate response.
- **Git-managed stack creation landed: `portainer_create_git_stack`.**
  Wraps `POST /api/stacks/create/standalone/repository?endpointId=N`.
  Closes the create symmetry — we now have file+git create + file+git
  redeploy + delete. Inputs: name, endpoint_id, repository_url,
  optional reference (default `refs/heads/main`), compose_path
  (default `docker-compose.yml`), env, and optional username/password
  for private repos (PAT visible in tool-call logs — caveat in tool
  description). Same pre-flight name-collision check as create_stack.
  Verified end-to-end against the live NAS 2026-04-30: created
  plex-mcp git-managed pointing at github.com/CarlDog/plex-mcp,
  user added PLEX_TOKEN via UI, ran portainer_redeploy_git_stack
  to confirm env round-trip preserves real secrets — token visually
  confirmed intact in Portainer UI after redeploy. The full
  delete + create_git_stack + redeploy_git_stack lifecycle works
  via MCP without UI ceremony beyond the secret entry.
- **One-shot file→git conversion: `portainer_convert_stack_to_git`.**
  Atomic delete-then-create-from-repo that PRESERVES env values
  server-side via the noRedact pattern — caller never has to
  re-enter secrets via the Portainer UI after conversion. Two-factor
  confirm (`confirm_name` matching the source stack's Name +
  `confirm: true`). Captures source compose YAML before delete; if
  the create step fails the thrown error includes the original
  compose plus the env KEY names (NEVER values — secrets stay
  protected even on the failure path) so the user can recover via
  `portainer_create_stack` + UI re-entry of secrets. Uses the
  repo's compose for the new stack (not the source's), so any
  port/volume divergence between source and repo is intentional.
  Refuses self-conversion of portainer-mcp (would die mid-call).
- **Programmatic env management: `portainer_set_stack_env`.**
  Add, update, or remove env vars on an existing stack without
  going through the Portainer UI. Auto-detects file-based vs
  git-managed and routes to the matching update endpoint, applying
  the caller's `set` (upsert) and `remove` ops to the existing env
  read with noRedact. Triggers a synchronous redeploy because
  Portainer can't change container env without restart, but does
  NOT pull a new image by default (env-only intent — `pull_image`
  defaults to false). Allows secret-pattern key names (e.g.
  PLEX_TOKEN, *_API_KEY) — the tool description warns that values
  passed in `set` appear in tool-call logs, but no other path
  exists for programmatically setting secrets. Closes the gap
  flagged from another session: env additions previously needed
  the Portainer UI.

## Next

- Add tests once a real Portainer test target is set up. Highest
  ROI: regression coverage for the env round-trip on both redeploy
  variants AND the convert tool — those are the paths most likely
  to silently corrupt state.
- Smoke-test `portainer_convert_stack_to_git` against the live
  NAS once the new image ships. Good target: any of the *-mcp
  stacks. After convert, the new stack should be git-managed AND
  retain its secrets without manual UI re-entry — the whole point
  of this tool vs. the manual delete+create_git_stack flow.
- Lower priority backlog (covered in PORTAINER-API.md "haven't
  built yet"):
  - `portainer_stack_start` / `portainer_stack_stop` (stack-level
    lifecycle — different from per-container start/stop)
  - `portainer_image_pull` / `_image_list` / `_image_inspect`
  - `portainer_endpoint_inspect` (cheap pre-flight guard for
    write tools)
  - `portainer_system_version` (richer than system_status when
    authenticated)

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
