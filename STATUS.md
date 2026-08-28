# Status

**Last updated:** 2026-08-28 — **v0.7.0**, closing 7 accumulated
`mcp-feedback` OpenChronicle memories (the dogfooding backlog) in one pass.
Tool count 26 → 30: `portainer_container_delete`, `portainer_list_networks`,
`portainer_inspect_network`, `portainer_prune_networks` are new; every
existing tool got at least a schema/description touch (`.strict()` on all
30, compact-by-default on three list/get tools, `get_stack` finally returns
`StackFileContent`, `container_logs` returns clean demuxed text). See Done
below for the full breakdown.

Previously: **v0.6.0**, this repo's first tagged release, under the new
fleet standard UNI-19. Three things landed with it: the backfilled
`CHANGELOG.md` UNI-12 requires; `flavor: latest=false` on the publish
workflow so a release tag no longer republishes `:latest`; and a real bug
fix — `package.json` read 0.6.0 while `src/index.ts` hardcoded `"0.1.0"`, so
the MCP initialize response had been reporting 0.1.0 to every client across
five minor versions. The version is now a single const in
`src/shared/version.ts` with `test/version-sync.test.ts` asserting it matches
the manifest (MCP-T03), so the two cannot drift again.

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
- **`portainer_compare_env_values` (2026-08-19).** Resolves the
  redacted-secret-fingerprint idea filed 2026-08-05 (below, in Next
  until now). Checks whether two containers' env values are equal
  without exposing either one: fetches both raw values server-side
  via the existing `noRedact` path, hashes with SHA-256, and does a
  constant-time digest comparison — returns only `match: true/false`
  plus `found`/`empty` flags per side. Pure comparison logic
  extracted as `compareEnvValuesResult` for unit testing (8 new
  cases, including one asserting the result object's JSON never
  contains the compared values) — 73/73 total. **Design choice
  discussed with the user before building:** considered a
  store-hash-at-write-time variant for drift detection (has a secret
  changed since it was last verified) instead of pairwise comparison.
  Rejected for now — it's a genuinely different feature (drift
  detection vs. equality-check), and this codebase is deliberately
  stateless (CLAUDE.md: "the container is stateless... no per-session
  state"); the session's own AutoUpdate self-redeploy and the
  self-redeploy-skips-auto-prune gap (both above) are exactly the
  kind of event that would silently wipe or orphan a "temporary" hash
  store. The shipped on-demand version needs no storage, no TTL, and
  fully solves the equality-check case that actually came up (the
  2026-08-05 KINDROID_MCP_TOKEN mismatch, and 2026-08-19's "does this
  new plex-companion token match kindroid-mcp's" question). Revisit
  drift detection separately if a real need for it shows up.

- **`portainer_set_stack_env` on a git-managed stack: honest docs +
  a real error instead of a raw git failure (2026-08-23, portainer-mcp#17).**
  Filed from real dogfooding: an env-only removal on a git-managed
  stack failed with `Unable get latest commit id... authentication
  required` regardless of `pull_image`. The tool description implied
  `pull_image: false` bought independence from git — it doesn't.
  Investigated the obvious-looking fix (route env-only changes through
  the file-based `PUT /api/stacks/{id}` endpoint) and found it's
  **wrong and dangerous**: that endpoint unconditionally wipes
  `stack.GitConfig` (see PORTAINER-API.md "Git stacks vs file stacks"),
  so it would silently detach the stack from git. Confirmed via the
  pinned Swagger spec that there's no flag to ask Portainer's
  git-redeploy endpoint to skip the pull — `RepullImageAndRedeploy`
  only governs the Docker image, not the git fetch, and the endpoint's
  own summary is literally "Pull and redeploy a stack via Git." So the
  real fix is smaller than the original issue proposed: the tool
  description and `pull_image` param now say plainly that a
  git-managed stack's env change *always* requires live git
  connectivity, and `setStackEnv`'s git-redeploy call now wraps a
  failure with that explanation plus the actual next step (fix the
  stored git credential, or use the Portainer UI) instead of
  surfacing Portainer's raw low-level git error unexplained. No
  routing change — this constraint is real, not a portainer-mcp bug.
  typecheck/lint/test/build all clean (77/77 tests; no new tests added
  — this is error-message wrapping around a live API call, not a pure
  function, and the codebase's own convention is real-instance
  integration tests over mocking, which a deliberately-broken-git-
  credential fixture isn't worth building for this).

- **HTTP transport hardened: bearer auth + Host allowlist + idle-session
  eviction (2026-08-28), closing both open phase-end-audit findings from
  2026-08-19 in one change.** Ported `src/shared/http-transport.ts`
  near-verbatim from plex-mcp/kindroid-mcp's canonical MCP-F03 template
  (only the logging calls adapted to this repo's plain `console.error`
  convention — no logger module here). `mountMcpHttp()` replaces the
  hand-rolled `/mcp` handler in `src/index.ts` and adds, in one place:
  a Host/Origin allowlist (`MCP_ALLOWED_HOSTS`) as the real DNS-rebinding
  defense (binding `0.0.0.0` is not itself a control inside a container —
  docker-deployments.md section 8); optional bearer auth (`MCP_AUTH_TOKEN`,
  constant-time SHA-256 digest compare) as a second layer; idle-session
  eviction (`MCP_SESSION_IDLE_MS`, default 30 min) via a periodic sweep;
  and graceful shutdown (`SIGTERM`/`SIGINT`) disposing the sweep and live
  sessions, which the old code had none of. Free bonus bug fix: an
  unknown/expired session id now answers the spec-required 404 instead
  of a blanket 400 — the client's only defined signal (2025-06-18,
  Session Management §3/§4) to re-initialize; the old 400 read as a
  generic protocol error and left the client wedged until a human
  restarted it. `test/http-transport.test.ts` (8 new cases, ported from
  plex-companion's vitest suite to this repo's `node --test`) enforces
  the 401/403/404 behaviors directly — 85/85 total. New `MCP_BIND_HOST`
  env var (default `127.0.0.1`; `docker-compose.yml` sets `0.0.0.0`,
  required wiring for the published port to work at all, matching
  kindroid-mcp's Dockerfile/compose split).
  **Rollout sequencing to avoid a self-inflicted lockout:** this
  session's own `portainer` MCP connection is `http://your-nas:3004/mcp`
  — a naive push would have 403'd it the moment the new image landed,
  since `docker-compose.yml`'s restrictive default (`MCP_ALLOWED_HOSTS`
  unset → compose substitutes `localhost`) doesn't match the real NAS
  hostname. Confirmed with the user that the NAS is the only real caller
  of `:3004`, then pre-staged `MCP_ALLOWED_HOSTS=<nas-hostname>` on the
  live stack (179) via `portainer_set_stack_env` *before* pushing — inert
  against the old code (which doesn't read that var), so no disruption,
  and already in place by the time the new image lands via AutoUpdate's
  5-minute git poll. `MCP_AUTH_TOKEN` deliberately left unset — that's a
  secret, so per this repo's own credential-input design principle it's
  the user's to add via the Portainer UI whenever they want bearer auth
  on top of the allowlist; the allowlist alone is the immediate fix for
  both audit findings. Package version bumped 0.5.0 → 0.6.0.
- **`MCP_AUTH_TOKEN` set on the live stack (179), local client configs
  updated to match (2026-08-28).** Following up on the allowlist-only
  rollout above: the user generated a token and set it via the
  Portainer UI (never seen or handled by this session — same boundary
  as every other credential in this codebase). Every local MCP client
  config pointing at `:3004` was updated with an `Authorization: Bearer`
  header — Claude Desktop (`mcp-remote --header`), VS Code (native
  `headers` + a `promptString` input so the token is entered once,
  securely, rather than committed to the config file), and Codex CLI
  (`[mcp_servers.portainer.http_headers]`) — mirroring the exact pattern
  each config already used for sibling MCPs (botify, filesystem, etc.).
  One real snag: Claude Desktop was running at the time of the first
  edit and silently flushed its own in-memory config back to disk,
  clobbering the change (caught via file-mtime comparison, not assumed);
  fully quitting the app before reapplying fixed it. This workstation's
  own Claude Code registration (`~/.claude.json`) was updated too —
  confirmed live in this same continued session, whose `portainer` MCP
  connection is already carrying the bearer header.
- **Dogfooding backlog closed: 7 `mcp-feedback` OC memories, 12
  findings, v0.6.0 → v0.7.0 (2026-08-28).** Triggered by the
  `mcp-dogfooding.md` closing-the-loop practice — surfaced the
  accumulated friction notes, user chose "everything, right now."
  Landed as 9 separate commits (per explicit instruction to keep
  logical groups separable), each independently typecheck/lint/format/
  test-clean before commit. Tool count 26 → 30; test count 87 → 123
  (baseline had already grown to 87 by the time this pass started, from
  concurrent HTTP-transport-hardening work — see the git-race note
  below). Highlights (full detail in each commit message):
  - `portainer_get_stack` now actually returns `StackFileContent` by
    default (`include_file=false` to skip it), fixing an "accepted and
    does nothing" gap between the tool's description and its
    implementation. Fails soft with `StackFileError` rather than
    silently omitting the field on a fetch error.
  - `portainer_set_stack_env` warns (`envWarnings` on the response) when
    a `set` key isn't referenced anywhere in the compose file — was a
    silent no-op before.
  - `portainer_list_endpoints`, `portainer_list_stacks`, and
    `portainer_get_container` are now compact-by-default
    (`full=true` opts into raw objects), matching
    `portainer_list_containers`'s existing 2026-07-30 pattern.
    `list_stacks` also gained a client-side `name` filter (Portainer's
    `/stacks` endpoint has no server-side one — confirmed against the
    pinned spec).
  - All 30 tool `inputSchema`s enforce `.strict()` — spiked against a
    real client/server round-trip first (not just source-reading)
    before committing to it across every tool, since
    mcp-server-authoring.md documents a sibling trap
    (`.refine()`/`.superRefine()` silently dropped by the same
    mechanism). Applied via a one-off TS-compiler-based script for
    byte-precision across 2000+ lines rather than 26 hand edits.
  - New tools: `portainer_container_delete`,
    `portainer_list_networks`/`_inspect_network`/`_prune_networks`.
  - `portainer_container_logs` demuxes Docker's stream-multiplexing
    frame headers server-side — see the Known Gaps entry above for why
    this had to operate on raw response bytes, not a decoded string.
  - `auto_update_interval`/`force_pull_image` on `create_git_stack` +
    `convert_stack_to_git` (confirmed no `Registries` field exists on
    this endpoint at all, per the pinned spec — image-poll-only, not a
    scope choice).
  - Error-body truncation cap 200 → 2000 chars;
    `recreate_container`'s description now documents its
    client-timeout-doesn't-mean-failure risk honestly.
  - **A concurrent session pushed to `main` mid-task** (`be2285b`,
    restoring the canonical pre-commit hook's author-identity check) —
    and its diff happened to also carry a byte-identical, independently
    derived fix for `get_stack`'s `id`→`stack_id` rename +
    `StackFileContent` fetch (bundled in, most likely accidentally, via
    a `git commit -a`/`-A` sweeping up unrelated uncommitted WIP). No
    real conflict — content matched exactly — but every commit from
    that point on was preceded by a `git fetch` + log check before
    pushing, to catch any further races early. Worth knowing: this repo
    can have more than one active Claude session at a time.
- **`portainer_container_logs` gained `since`/`until` (2026-08-28,
  same-day follow-up to the dogfooding pass above).** Closes the other
  half of the 2026-06-03 finding that the demux fix left open. New pure
  helper `parseDockerTimeFilter` mirrors `docker logs --since`'s own
  CLI convention rather than inventing a new format: a bare integer is
  an absolute Unix timestamp, an RFC3339 datetime is absolute, and a
  relative duration (`"10m"`, `"1h30m"`, `"45s"`, any combination of
  d/h/m/s) counts back from now. Docker's raw HTTP API only accepts
  Unix-timestamp seconds for `since`/`until`, so the conversion happens
  client-side before the request. 10 new table-driven test cases
  (123 → 133 total). Still open: an optional server-side substring/
  regex filter, the narrower remaining piece of the original finding.

## Next

- ~~Idea filed for future discussion (2026-08-05): a redacted-secret
  fingerprint tool.~~ **Shipped 2026-08-19 as `portainer_compare_env_values`**
  — see Done above for the full writeup, including the design
  discussion around a store-hash-at-write-time alternative that was
  considered and rejected in favor of the stateless on-demand version
  actually shipped.
- Add tests once a real Portainer test target is set up. Highest
  ROI: regression coverage for the env round-trip on both redeploy
  variants AND the convert tool — those are the paths most likely
  to silently corrupt state.
- ~~Smoke-test `portainer_convert_stack_to_git` against the live
  NAS once the new image ships.~~ **Done 2026-08-19**, twice over: a
  real (non-self) conversion of plex-companion first surfaced the
  private-repo atomicity gap (see Done log — the incident that led to
  `git_credential_id`), then a clean retry with `git_credential_id: 1`
  succeeded fully — new stack, git-managed, secrets retained via the
  env round-trip with zero manual UI re-entry, ground-truth verified
  via container inspect. The tool's core promise is now live-proven.
- ~~[2026-08-19 phase-end audit] HIGH — HTTP transport has zero
  authentication.~~ **Resolved 2026-08-28** — see Done above
  (`src/shared/http-transport.ts`). Host/Origin allowlist is the actual
  fix (bearer auth is an optional second layer, off by default).
- ~~[2026-08-19 phase-end audit] MEDIUM — no idle-session eviction on
  the HTTP transport.~~ **Resolved 2026-08-28** — see Done above, same
  change (`mountMcpHttp()`'s periodic sweep, `MCP_SESSION_IDLE_MS`).
- **[2026-08-19 phase-end audit] LOW — `src/portainer.ts` is now 2700
  lines** (was 2090; the dogfooding backlog below added ~600 more).
  CLAUDE.md's own documented refactor trigger for pulling tool
  registrations into `src/tools/<name>.ts` was already arguably crossed
  by `portainer_compare_env_values`; four more tools and several new
  pure helpers later, the file is still cleanly organized (pure
  functions, then the client class, then tool registrations) but the
  case for splitting is stronger than it was. Still not urgent — queue
  as its own stage with proper planning if it's picked up, not a
  silent "while I'm in here" split.
- ~~Clean up `portainer_container_logs` output + add `since`/`until`.~~
  **Fully done 2026-08-28** — demuxing landed first (see Done below);
  `since`/`until` followed the same day, accepting a Unix timestamp,
  RFC3339 datetime, or a relative duration ("10m", "1h30m") mirroring
  `docker logs --since`'s own CLI convention (`parseDockerTimeFilter`,
  10 new test cases). **Still open:** an optional server-side
  substring/regex filter — `since`/`until` covers "just the last N
  minutes," not "only lines matching X" — that narrower piece of the
  original 2026-06-03 finding remains unbuilt.
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

- **Declined: exposing stack webhook trigger/management as MCP tools
  (2026-08-19).** User asked whether Portainer's webhook-triggered
  image updates could be adopted into portainer-mcp. Declined for two
  reasons: (1) a stack's webhook UUID is functionally a bearer token —
  `POST /stacks/webhooks/{id}` is public, no auth, and triggers a
  redeploy on knowledge of the UUID alone, so any tool that surfaces
  it puts a live unauthenticated-redeploy credential into the
  conversation transcript and any session-history persistence, same
  risk class as the credential-input principle above but on the
  output side; (2) it's functionally redundant — `portainer_redeploy_stack`
  / `portainer_redeploy_git_stack` already perform the identical
  action over the authenticated API portainer-mcp already uses, so
  there's no capability gain to justify the exposure. This mirrors
  the existing non-goal already recorded in
  [PORTAINER-API.md](docs/PORTAINER-API.md) ("Webhooks are public").
  The investigation did surface a real, already-shipped gap — see
  "Known Gaps" below (Stack `Webhook` field leaked in plaintext).

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
  passed).** The tool's own docstring only warned about converting
  portainer-mcp's *own* stack (the process dies mid-call). It did
  NOT warn that ANY stack pointing at a private repo, called without
  credentials, hits the identical delete-succeeds/create-fails hole —
  `authentication required: Repository not found` from the create
  step, after the source stack (and its running container) is
  already gone. Full outage, not just a stack-record loss;
  `portainer_list_containers` confirmed the container itself was
  removed too. Recovered via `portainer_create_stack` using the
  tool's own recovery payload (compose YAML verbatim + env key
  names) plus values reconstructed from earlier session context —
  3 of 24 env vars (real secrets) were unrecoverable and left blank
  pending manual re-entry. Two fixes identified:
  - **Done 2026-08-19: broadened the tool description.** Now states
    the general private-repo failure mode (not just self-conversion)
    and proactively says the tool is the right, safer choice for
    every *other* stack vs. a manual UI delete-and-recreate — closing
    the AI-behavior gap recorded in the fleet lesson
    `2026-08-19-manual-git-stack-recreation-drops-env-vars`.
  - **Done 2026-08-19: `git_credential_id` param on both
    `portainer_create_git_stack` and `portainer_convert_stack_to_git`.**
    Removes the actual root cause of this incident — no more calling
    either tool against a private repo with no credentials at all.
    References an existing Portainer-stored credential by id, so
    nothing secret transits the tool call; mutually exclusive with
    `username`/`password`, validated up front in both client methods
    (in `convertStackToGit`, specifically *before* the delete step, so
    a bad combination now refuses cleanly instead of deleting the
    source first). Wire field `RepositoryGitCredentialID` confirmed by
    reading Portainer's served frontend bundle and live-verified
    against CE 2.39.6 (throwaway create with a deliberately
    nonexistent compose path — proved the credential-based git clone
    succeeded before failing cleanly on the intentional bad path, zero
    orphaned state). See CLAUDE.md "Secrets in tool INPUTS" for the
    field-level detail.
  - **Still open:** pre-flight-checking repo reachability/auth
    *before* deleting the source stack in `convert_stack_to_git`,
    converting a bad-repo-URL or truly-missing-credential case from an
    outage into a clean refusal (mirrors the existing name-collision
    pre-flight on `create_stack`/`create_git_stack`). Lower priority
    now that `git_credential_id` removes the most common way to hit
    this in practice, but the underlying delete-before-create
    ordering is still there for other failure modes (bad ref, bad
    compose path, network blip).
  See OC memory `ed84beab-5398-4142-a032-cdd27a60bd70` (incident) and
  `d6baf633-1609-4a0d-b097-f6a28999691d` (git-credential-ID
  resolution) for full detail.
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
  - ~~**Demultiplex + clean the stream.**~~ **Done 2026-08-28** —
    `demuxDockerLogs` strips the 8-byte frame headers and returns clean
    newline-delimited UTF-8, operating on the raw response bytes (not an
    already-decoded string, which would corrupt any length byte ≥ 0x80
    for payloads ≥128 bytes). No inspect-Config.Tty call needed: an
    unframed (TTY) stream is detected by failing to parse as a complete,
    gapless sequence of valid frames, falling back to raw text. See Done
    below.
  - ~~**Server-side filtering to bound the payload.**~~ **`since`/`until`
    done 2026-08-28** — `parseDockerTimeFilter` accepts a Unix
    timestamp, an RFC3339 datetime, or a relative duration ("10m",
    "1h30m"), mirroring `docker logs --since`'s own CLI convention;
    Docker's raw HTTP API only takes Unix-timestamp seconds, so the
    conversion happens client-side. **Still open:** an optional
    substring/regex `grep` filter applied server-side — lets a caller
    pull "only lines matching `grid fill`" instead of a giant tail,
    the narrower remaining piece of this finding.
- ~~`portainer_list_containers` dumps raw full objects for ALL
  containers — token-limit pain on a busy host (2026-06-04).~~
  **Resolved 2026-07-30** — server-side `filters` (name/label/status)
  and a compact-by-default projection shipped together; see the Done
  entry below. This Known Gaps note should have been struck through
  then and wasn't — caught during the 2026-08-28 dogfooding pass while
  applying the identical fix to `list_endpoints`/`list_stacks`/
  `get_container`.
- API key from `.env` is the only auth path. For multi-Portainer setups
  this would need to be revisited, but single-instance is the v1 target.
- ~~Stack `Webhook` field leaked in plaintext.~~ Resolved 2026-08-19:
  found while researching a user request to add webhook-trigger tools
  (see "Design Principles" above — that request was declined,
  functionally redundant with the existing authenticated redeploy
  tools and adds secret-exposure surface for no capability gain). The
  investigation turned up a real, already-shipped gap: a stack's
  `Webhook` UUID
  (`POST /stacks/webhooks/{id}` — public, no auth, triggers a redeploy)
  is a top-level scalar field, not an `Env` array entry, so it sat
  outside `redactSecrets`'s scope. `portainer_list_stacks` and
  `portainer_get_stack` were returning it verbatim — confirmed live
  against the NAS (18 of 35 stacks currently have one provisioned).
  Fixed by special-casing any `webhook`-named key (case-insensitive,
  any nesting depth) the same way `env` is special-cased: non-empty
  values become `<redacted>`, empty string (no webhook configured)
  passes through since it isn't secret. Four new cases in
  `test/redact.test.ts`. See CLAUDE.md "Conventions" for the detail.
