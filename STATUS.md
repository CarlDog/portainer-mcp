# Status

**Last updated:** 2026-08-19

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
- GitHub Actions: `docker-publish.yml` (GHCR, amd64-only since 7999754)
  and `test.yml` (typecheck/build/test matrix + lint/format quality job;
  the matrix runs the unit suite via `npm test` since 2026-07-28)
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
- OpenChronicle registered user-scope HTTP at
  `http://your-nas:18000/mcp/` (NAS Portainer stack 151). Project
  id `5e12a080-0f4d-405c-a2c6-86026f6aae49`. Initial entry was a stale
  local-scope `oc mcp serve` from before the v3 NAS deployment; that
  was removed 2026-05-06 — local-only OC is no longer used.
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
- **Compose YAML edit tool: `portainer_update_stack_file`
  (2026-05-06).** Closes the gap surfaced from a chat session that
  needed to add `extra_hosts` to several inline stacks (sonarr,
  radarr, lidarr) — `portainer_redeploy_stack` only round-trips the
  existing file unchanged, so editing the YAML required the Portainer
  UI. New tool replaces the stored compose with caller-provided YAML
  and redeploys. Round-trips stack-level Env so secrets aren't wiped
  (same noRedact pattern as redeploy_stack). Refuses git-managed
  stacks (edit the repo and use redeploy_git_stack) and
  non-Compose/Swarm types. `confirm: true` required. Refactored the
  type-check + git refusal out of `redeployStack` into a private
  `assertFileBasedStack` helper that both methods now share — light
  tidy, behavior unchanged. No tests yet (project-wide gap, see
  Next).
- **Volume read tools: `portainer_list_volumes` +
  `portainer_inspect_volume` (2026-05-02).** Read-only audit
  surface for the orphan-volume-accumulation problem. `list_volumes`
  wraps `GET /api/endpoints/{id}/docker/volumes` and exposes
  Docker's filter API (`dangling: true` for unused-only,
  `dangling: false` for in-use-only, `name` for substring match).
  `inspect_volume` wraps `GET /volumes/{name}` for detail
  (Mountpoint host path, Labels including the Compose project
  label that maps back to a stack name, CreatedAt). Designed for
  "audit unused volumes via Claude" workflows — surfaces what's
  in the UI's Volumes page without hunting. Pure reads, zero risk.
  Prune (`POST /volumes/prune`) deliberately not built —
  auto-removal of "unused" stateful storage is dangerous (Docker's
  definition of "unused" includes brief stack-redeploy windows
  where containers detach temporarily). Manual cleanup via UI or
  CLI remains the safer pattern.
- **Dependabot #31 cleared (2026-07-28).** Bumped
  `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, which widened its
  `@hono/node-server` range to `^1.19.9 || ^2.0.5`; lockfile now
  resolves 2.0.12, past the path-traversal fix (GHSA, moderate,
  Windows-only serve-static — low practical risk here since the
  container is Linux and our HTTP transport is express, but cleared
  properly rather than dismissed). package.json SDK floor raised to
  `^1.30.0`. Verified: typecheck + build + 44/44 tests + local HTTP
  smoke (initialize, tools/list → 23 tools). Remaining `npm audit`
  highs are all the dev-only eslint chain (needs eslint 10 major —
  queued as a separate task).
- **Dev-only eslint chain bumped to v10 (2026-07-28).** eslint ^9 →
  ^10.8.0, @eslint/js ^9 → ^10.0.1, eslint-config-prettier ^9 →
  ^10.1.8. typescript-eslint stays ^8.65.0 — its peer range already
  covers eslint 10, no major needed. Clears the 5 high-severity
  npm-audit findings (vulnerable minimatch/brace-expansion via
  @eslint/config-array + @eslint/eslintrc — DoS via unbounded brace
  expansion); `npm audit` now reports 0 vulnerabilities. Flat config
  in eslint.config.js unchanged. ESLint 10's recommended set added
  `preserve-caught-error`, which flagged the convert-stack recovery
  throw in `convertStackToGit` — fixed properly by attaching
  `{ cause: createErr }` (message text unchanged, so the MCP-facing
  recovery payload is identical; the cause preserves the original
  stack for server-side debugging). Verified: lint clean, typecheck
  clean, 44/44 tests. Dev-only — no runtime deps touched, no Docker
  image behavior change. These were npm-audit findings only; no open
  Dependabot alerts existed for them (checked via API).
- **LF checkouts enforced repo-wide (2026-07-28).** `.gitattributes`
  gained `* text=auto eol=lf` — `.prettierrc.json` pins
  `endOfLine=lf`, so Windows CRLF checkouts (core.autocrlf) made
  local `format:check` fail on every file while CI stayed green. The
  index was already fully LF (renormalize was a zero-diff no-op);
  only working-tree materialization changes. Also added `.claude/` to
  `.prettierignore` + eslint ignores so root-level prettier/eslint
  runs stop walking into Claude Code worktrees under
  `.claude/worktrees/`. Follow-up: lint/format config
  (`.prettierignore`, `.prettierrc.json`, `eslint.config.js`) and
  developer-side git tooling (`.githooks/**`, `.gitleaks.toml`) added
  to `docker-publish.yml`'s `paths-ignore` — none can affect the
  image, and the 7c567b6 push showed a lint-config-only change
  needlessly rebuilding + bouncing the NAS stack.
- **CI now runs the unit suite (2026-07-28).** `test.yml`'s 3-OS matrix
  gained a Test step (`npm test`, the 44-case redact suite from a0f81c7)
  after Build — closes the residual from fleet-review issue #1, whose
  Health note flagged that the Test workflow never executed tests. Also
  added `.github/workflows/test.yml` to `docker-publish.yml`'s
  `paths-ignore` (same reasoning as `.gitattributes` in 1388aa0: CI
  config can't affect the image, so don't rebuild + bounce the stack).
- **`portainer_list_containers` bounded + filterable (2026-07-30).**
  The 2026-06-04 Next item, worked from the fleet queue: Docker's
  native `filters` exposed as `name` / `label` / `status` params
  (label maps stack → containers via `com.docker.compose.project`,
  resolving the 2026-07-29 dogfooding incident's compose-name
  archaeology in one call), plus a compact projection by default
  (`Id`/`Names`/`Image`/`State`/`Status`/`Created`/`Ports`/
  `ComposeProject`) with `full: true` for raw objects. A `status`
  filter implies `all=true` — Docker's running-only window would
  otherwise return [] for `status=exited` and look like a working
  filter. Pure helpers `containerListQuery` + `compactContainer`
  with table-driven tests (55-case suite total); verified live
  against the NAS: 46/37/1/7 counts across filter variants, compact
  payload 92% smaller (126.8 KB → 10.3 KB). v0.2.0.
- **Dependabot alerts #42–44 cleared (2026-08-05).** All three were
  the same root cause: `undici` resolved to 6.27.0 in the lockfile
  even though package.json's existing `^6.0.0` range already covered
  the fix. Bumped to 6.28.0 (also the latest 6.x) clears all three —
  downstream response desync via the retry interceptor, cookie
  attribute injection via unsanitized `domain`/unparsed `setCookie`,
  and CRLF injection via a blob-like body's `type` property.
  Lockfile-only change; package.json untouched. Also bumped
  `brace-expansion` (dev-only, via eslint→minimatch) to 5.0.9,
  clearing a high-severity DoS finding that `npm audit` still flagged
  locally even though GitHub had auto-dismissed the corresponding
  alert (#40) for its own reasons — no runtime impact either way,
  since it's dev-only. Verified: typecheck + build + lint + format +
  55/55 tests all clean; `npm audit` now reports 0 vulnerabilities.
- **Image cleanup: `portainer_list_images` + `portainer_prune_images`,
  and automatic dangling-image prune wired into every redeploy/recreate
  tool (2026-08-18).** Motivated by 100+ unused/orphaned images
  observed on the NAS from routine rebuild-and-repush churn
  (docker-deployments.md rule 5: every push that changes a digest
  bounces the container and leaves the superseded digest dangling).
  Considered a time-based cron first; rejected in favor of hooking
  cleanup to the actual moment images become orphaned — a redeploy
  swapping a tag to a new digest — since that's precise and needs no
  new scheduling infra.
  - `portainer_list_images` — `GET /api/docker/{id}/images?withUsage=true`
    (Portainer-native handler, not the Docker proxy tree). Returns
    `{id, tags, size, created, used}` per image; `used` is what makes
    "orphaned" answerable without cross-referencing every container.
  - `portainer_prune_images` — `POST /api/endpoints/{id}/docker/images/prune`
    (Docker proxy passthrough). Default `dangling`-only (Docker's own
    `docker image prune` default); `all_unused: true` opts into the
    aggressive `-a` mode (also removes tagged-but-unused images — can
    delete a rollback candidate, so it's a separate explicit call, never
    the default). `confirm: true` required either way.
  - **Auto-prune:** `portainer_redeploy_stack`, `portainer_update_stack_file`,
    `portainer_redeploy_git_stack`, and `portainer_recreate_container` now
    run a dangling-only prune on the affected endpoint immediately after
    a successful redeploy/recreate, merging the result onto the response
    as `imagePrune` (`withImagePrune` in `src/portainer.ts`). A prune
    failure is caught and reported in `imagePrune.error` rather than
    failing the redeploy — the redeploy already succeeded and is the
    thing that matters. Always dangling-only; `all_unused` stays a
    manual, separately-confirmed `portainer_prune_images` call.
  - **Known gap:** a redeploy triggered by Portainer's own git-auto-update
    polling (no MCP call involved at all) isn't covered — nothing calls
    our tools in that path. Most of this fleet's redeploys go through
    these tools already, so the gap is believed small, but it means this
    isn't 100% coverage of every possible redeploy source.
  - **Second known gap, found live on first deploy (2026-08-18):**
    `portainer_redeploy_stack`/`_update_stack_file`/`_redeploy_git_stack`/
    `_recreate_container` redeploying **portainer-mcp's own stack** don't
    get the auto-prune either — for a different reason than the git-
    auto-update gap. The redeploy replaces the very container whose
    process is handling that HTTP request; Portainer's PUT completes and
    swaps the container, but the calling process gets killed as part of
    that swap before it reaches the `pruneDanglingAfterRedeploy` call
    (same root cause as the documented in-flight-connection-drop quirk
    on these tools — the response is lost for the identical reason).
    Confirmed live: redeploying stack 129 (portainer-mcp) with the new
    code left `ghcr.io/carldog/portainer-mcp:<none>` sitting `used:
    false`; a manual `portainer_prune_images` call cleaned it up (7
    images, 17.4 MB). Not fixable by re-ordering the client code — the
    process is gone, there's nothing left to run a follow-up call. Any
    *other* stack's redeploy is unaffected (that calling process stays
    alive to finish the request) — this is specific to self-redeploy.
    Practical mitigation: after redeploying portainer-mcp's own stack,
    follow up with one manual `portainer_prune_images` call.
  - Pure helpers `imagePruneQuery` + `withImagePrune`, table-driven tests
    (9 new cases; 65/65 total). Typecheck/lint/format/build all clean.
    **Smoke-tested live against the NAS 2026-08-18:** pushed → CI
    published `ghcr.io/carldog/portainer-mcp:latest` → redeployed stack
    129 via `portainer_redeploy_stack` → verified via
    `portainer_get_container` that the running container's
    `org.opencontainers.image.revision` label matched the pushed commit
    SHA and the healthcheck was green → `portainer_list_images` correctly
    showed the superseded digest as `used: false` → `portainer_prune_images`
    removed it and reclaimed 17.4 MB, verified gone on a follow-up list.
  - Tool count: 23 → 25 (10 read, 15 write). `CLAUDE.md`'s stale
    "Phase: scaffolding" line (long superseded by the deployed-and-
    verified phase this file already describes) was also fixed while
    touching that section.
- **`docker-compose.yml` was missing `network_mode: bridge` that the
  live stack already had (found 2026-08-18, mid-conversion to git-
  managed).** The deployed stack's actual compose (confirmed both from
  the operator's copy of the live Portainer stack file and independently
  from `portainer_get_container`'s `HostConfig.NetworkMode: "bridge"`)
  carries `network_mode: bridge`; the repo's committed compose didn't.
  Root cause: the fleet-wide single-container → `network_mode: bridge`
  migration (`docker-deployments.md` rule 11, ~24 stacks migrated to fix
  the NAS's Docker IPv4 address-pool exhaustion) was applied operationally
  in Portainer but never round-tripped back into this repo. Caught before
  it caused damage — converting to a git-managed stack pulls the repo's
  compose as source of truth, so deploying the (until now) stale repo
  version would have silently dropped this stack back onto its own
  dedicated network and reintroduced the pool-exhaustion risk. Fixed by
  adding `network_mode: bridge` to `docker-compose.yml`, matching live
  state exactly (single-container stack, no other service needs
  container-name DNS — the correct case per rule 11). This bumps the
  image digest and republishes on push (docker-compose.yml isn't in
  `docker-publish.yml`'s `paths-ignore`), so expect one more container
  bounce before the git-managed conversion, independent of that
  conversion itself.
- **Own stack (129) converted to git-managed (2026-08-19), by hand
  via the Portainer UI rather than `portainer_convert_stack_to_git`.**
  That tool explicitly refuses to be safe for self-conversion (its own
  description: "do not run this against the portainer-mcp stack itself
  — the call dies mid-flight when portainer-mcp is killed") — it's
  delete-then-create in one server-side call, and unlike a redeploy
  (where Portainer completes the swap even if the response is lost),
  a delete has nothing that auto-recreates the container if the create
  step never runs. Scripting the same two calls from the local dev
  machine was also rejected — it would have required pulling
  portainer-mcp's own `PORTAINER_API_KEY` out to plaintext, which the
  whole redaction architecture in this codebase exists to avoid.
  Sequence used: delete stack 129 (file-based) → Portainer UI → Add
  stack → **Repository** build method (not Web editor — pasting the
  compose YAML there creates another file-based stack even if the YAML
  is byte-identical, which is exactly what happened on the first
  attempt and had to be redone) → new stack 179, `GitConfig.URL`
  pointing at this repo, `ReferenceName: refs/heads/main`,
  `ConfigFilePath: docker-compose.yml`. Hit one real bug along the way:
  the re-entered `PORTAINER_URL` env var was set to the NAS's own LAN
  hostname instead of `host.docker.internal` — a container can never
  resolve the host's own hostname (`docker-deployments.md` rule 1),
  surfaced as `getaddrinfo ENOTFOUND` from inside the container.
  Fixed by re-pointing it at `host.docker.internal:9443` (the value
  the compose's existing `extra_hosts: host.docker.internal:host-gateway`
  entry supports). Verified after fix: `portainer_system_status`
  reachable, container healthy, `org.opencontainers.image.revision`
  matching the latest pushed commit, `NetworkMode: bridge` confirmed.
  **New standing gap this introduces:** stack 179's `AutoUpdate.Interval`
  is `"5m"` — Portainer polls the repo every 5 minutes and redeploys on
  its own if the git ref or image changed, with no MCP call involved.
  This is a live instance of the already-documented git-auto-update
  coverage gap on the auto-prune feature (CLAUDE.md "Tool surface"):
  every such auto-redeploy leaves a dangling image that only a manual
  `portainer_prune_images` (or the next MCP-driven redeploy of *any*
  stack on this endpoint, since prune targets the whole endpoint) will
  clean up. Not fixed; flagging so it isn't mistaken for full coverage.

## Next

- **Idea filed for future discussion (2026-08-05): a redacted-secret
  fingerprint tool.** Surfaced live while debugging a real incident:
  plex-companion's `KINDROID_MCP_TOKEN` and kindroid-mcp's own
  `MCP_AUTH_TOKEN` were supposed to be the same value (a cut/paste
  dropped a character), and there was no way to check equality without
  either exposing the raw values or getting NAS shell access — the
  redactor (working as designed) strips both from every read tool
  here, and there's no exec-into-container capability at all. Direction
  to explore later: a narrow read tool (e.g.
  `portainer_container_env_fingerprint(container_id, endpoint_id,
  var_name)`) that fetches the one named env var via the existing
  noRedact-style internal path and returns ONLY a SHA-256 digest (or an
  8-char prefix) of its value — never the plaintext. Two containers'
  same-purpose secrets can then be compared for equality (same digest
  = same value) without either value ever crossing the MCP wire. Same
  safety shape as a git commit hash or npm integrity hash: a
  non-reversible fingerprint, not a secret itself. Scope stays narrow —
  one var by name, hash-only response, no bulk/wildcard fingerprinting
  that could turn into a redactor bypass. Not scoped, not started.
- Add tests once a real Portainer test target is set up. Highest
  ROI: regression coverage for the env round-trip on both redeploy
  variants AND the convert tool — those are the paths most likely
  to silently corrupt state.
- Smoke-test `portainer_convert_stack_to_git` against the live
  NAS once the new image ships. Good target: any of the *-mcp
  stacks. After convert, the new stack should be git-managed AND
  retain its secrets without manual UI re-entry — the whole point
  of this tool vs. the manual delete+create_git_stack flow.
- **Clean up `portainer_container_logs` output + add filtering.**
  Now a proven pain point (2026-06-03, see Known Gaps): demux the
  Docker 8-byte frame headers → newline-delimited text, and expose
  `since`/`until`/`timestamps` + an optional server-side substring
  filter so callers can bound the payload under token limits.
  Highest-value read-tool improvement — surfaced while reading
  wobblebot's daemon logs from another session.
- Lower priority backlog (covered in PORTAINER-API.md "haven't
  built yet"):
  - `portainer_stack_start` / `portainer_stack_stop` (stack-level
    lifecycle — different from per-container start/stop)
  - ~~`portainer_image_pull` / `_image_list` / `_image_inspect`~~
    `_image_list` shipped 2026-08-18 as `portainer_list_images`
    (Portainer-native `withUsage` shape). `_image_pull` / `_image_inspect`
    still not built — low priority, no concrete use case yet.
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

## Design Principles

- **Secrets that the user must supply belong in the Portainer UI, not
  in tool inputs.** Tools that accept a `password`/`token`/`pat`
  parameter cause the value to land in the conversation transcript,
  tool-call log, and any session-history persistence (Claude Desktop
  history, OpenChronicle, etc.). The Portainer UI's password field is
  more ephemeral by comparison — browser session, in-memory form
  state, gone on refresh. We have three tools today that accept
  credentials as input (`portainer_set_git_auth`,
  `portainer_create_git_stack`, `portainer_convert_stack_to_git`)
  and they remain available because the convenience is real for
  initial setup. But:
  - **Use them sparingly and with scoped, easy-to-rotate PATs.**
  - **Prefer the Portainer UI for credential rotation** — the entry
    surface is more transient than chat.
  - **Do not add new tools that take secrets as input by default.**
    Specifically: registry credential update, named git credential
    create/update, etc. should remain UI-only operations.
  - **Pure read/inspect/delete tools that touch credential records
    are fine** — they don't transit secret values.

  Logged 2026-05-01 after a session-end audit caught the gloss-over
  in proposing `portainer_update_registry`. Future write tools that
  need server-side secret handling should explore alternatives like
  named-credential references or stored-secret pointers, NOT raw
  password parameters.

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
- Redactor coverage is **key-based + issuer-prefix value-based, NOT
  generic entropy.** Both detection paths are now live (see CLAUDE.md
  "Conventions" for the pattern list). A high-entropy opaque string
  stored under a key that doesn't match the pattern AND whose value
  doesn't match a known issuer prefix (e.g. a custom 64-char API
  token your in-house service mints with no recognizable prefix)
  would still pass through. Adding generic entropy/length thresholds
  was rejected as Strategy B during the 2026-04-30 design pass —
  too many false positives on UUIDs, content hashes, and Docker
  container IDs that the LLM legitimately needs to read. Acceptable
  trade-off given the issuer-prefix coverage.
- ~~No MCP tool to add or update git auth on an existing
  git-managed stack.~~ **Closed by `portainer_set_git_auth`
  (2026-05-01).** Wraps `POST /api/stacks/{id}/git` with the
  required env + AutoUpdate + ReferenceName + TLSSkipVerify
  round-trips so the wipe traps on that endpoint don't bite. Two
  modes: pass `username` + `password` to set auth, or
  `remove: true` to wipe stored creds. Does NOT trigger a redeploy
  — pair with `portainer_redeploy_git_stack` to actually exercise
  the new credentials. Unblocks the botify private-flip workflow:
  set git auth on the stack while the repo is still public, then
  flip private and redeploy. Same caveat as other tools that
  accept secrets in input: the `password` parameter is visible in
  tool-call logs, so use a scoped read-only PAT.
- **`portainer_convert_stack_to_git` doesn't clean up orphan
  containers from a failed create.** When the create-from-git step
  fails after the source stack has already been deleted, Portainer's
  compose deploy may have already created (but not started)
  containers from the repo's compose file. The error path emits a
  recovery payload with the original compose YAML + env key names
  so the user can rebuild via `portainer_create_stack`, but does
  NOT issue `docker compose down --remove-orphans` for the failed
  project. Result: half-created containers from the failed deploy
  linger and re-attach to the recovered stack via project label.
  Surfaced empirically 2026-05-01 during the openchronicle-mcp
  convert (the OC repo's `docker-compose.yml` has 4 services where
  the deployed file-based version had only 2; bind-mount on
  `./plugins` failed; 2 orphan containers remained). User cleanup
  via Portainer UI's container Remove. Future enhancement: emit
  the orphan cleanup as part of the convert error path.
- **`portainer_convert_stack_to_git`'s delete-then-create atomicity
  risk is not limited to self-conversion — confirmed live 2026-08-19
  on plex-companion (stack 168, private repo, no credentials
  passed).** The tool's own docstring only warns about converting
  portainer-mcp's *own* stack (the process dies mid-call). It does
  NOT warn that ANY stack pointing at a private repo, called without
  `username`/`password`, hits the identical delete-succeeds/
  create-fails hole — `authentication required: Repository not
  found` from the create step, after the source stack (and its
  running container) is already gone. Full outage, not just a
  stack-record loss; `portainer_list_containers` confirmed the
  container itself was removed too. Recovered via
  `portainer_create_stack` using the tool's own recovery payload
  (compose YAML verbatim + env key names) plus values reconstructed
  from earlier session context — 3 of 24 env vars (real secrets)
  were unrecoverable and left blank pending manual re-entry. Two
  fixes worth doing, neither started: (1) the tool description should
  warn generally — "will fail for any private-repo target called
  without credentials, not just self-conversion" — rather than only
  the self-conversion case; (2) the tool could pre-flight-check repo
  reachability/auth *before* deleting the source stack, converting
  this from an outage into a clean refusal (mirrors the existing
  name-collision pre-flight on `create_stack`/`create_git_stack`).
  See OC memory `ed84beab-5398-4142-a032-cdd27a60bd70` for full
  incident detail including the still-open git-credential-ID
  investigation this triggered.
- ~~No regression test for the redactor yet committed.~~ Resolved
  2026-07-12: `test/redact.test.ts` (44 table-driven cases, `node
  --test` via `npm test`) covers key-name matching (incl. the new
  url/uri/conn and pw/pwd tokens), every value-shape pattern (incl.
  inline-credential URLs), both wire shapes (`[{Name,Value}]` and
  `"KEY=VALUE"`), `Env`/`env` casing, nested `Config.Env`, and
  false-positive guards for UUID/hash/Docker-ID/plain URLs.
- **Container logs are returned raw — and this is now a proven pain
  point (2026-06-03).** `containerLogs` hands back Docker's raw 8-byte
  stream-multiplexing frame headers (a `0x01`/`0x02` stream byte + 3 zero bytes + a 4-byte big-endian length, once per write) AND, because the
  result is a single JSON-escaped string, newlines arrive as literal
  `\n` — so a `tail` of any size comes back as ONE ~65–110 KB line.
  Two consequences hit while reading wobblebot's daemon logs from
  another session: (1) the blob blew past the caller's token limit on
  `tail` ≥ ~250 lines and had to be spilled to a temp file and
  re-parsed; (2) line-based chunking is impossible because there are
  no real newlines. Improvements worth developing:
  - **Demultiplex + clean the stream.** Strip the 8-byte frame
    headers (`header[0]` = stream type, `header[4:8]` = big-endian
    payload length) and return clean newline-delimited UTF-8. A TTY
    container's stream isn't framed — detect (inspect `Config.Tty`)
    and pass through.
  - **Add server-side filtering to bound the payload.** Docker's logs
    endpoint natively supports `since` / `until` (RFC3339 or relative)
    and `timestamps`; expose those, plus an optional substring/regex
    `grep` filter applied server-side. Lets a caller pull "just the
    last 10 min" or "only lines matching `grid fill`" instead of a
    giant tail — the real fix for the token-limit hit.
- **`portainer_list_containers` dumps raw full objects for ALL
  containers — token-limit pain on a busy host (2026-06-04).**
  `listContainers` (`src/portainer.ts`) passes Docker's
  `/api/endpoints/{id}/docker/containers/json` response straight through
  `asText()` with no projection and no filter — each element is the full
  container object (NetworkSettings, Mounts, HostConfig, Labels, Ports,
  Command, …). On the NAS (47 containers) the result is ~169 KB /
  4,592 lines; it blew the caller's token limit during a wobblebot soak
  check-in and had to be spilled to a temp file + filtered client-side to
  find the 8 `wobblebot-*` daemons. The `all` flag is the only knob today.
  Two improvements (mirrored in Next):
  - **Expose Docker's native `filters`** (name / status / label), exactly
    as `portainer_list_volumes` already does (dangling / name) —
    `?filters={"name":["wobblebot"]}` filters server-side; the real fix.
  - **Compact projection by default** — `Id` / `Names` / `Image` /
    `State` / `Status` / `Created` per container, opt-in `full` for the
    raw objects (full detail already lives in `portainer_get_container`).
    Cuts the payload ~50× even without a filter.
- API key from `.env` is the only auth path. For multi-Portainer setups
  this would need to be revisited, but single-instance is the v1 target.
