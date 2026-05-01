# Portainer API — reference & gotchas

This file curates external references for the Portainer CE REST API
and captures the gotchas we've hit (or expect to hit) while building
portainer-mcp. It is the working map for designing tool batches —
read it before adding new tools so the design is grounded in
documented behavior, not discovered at runtime.

This is a living document. When you discover a new quirk, add it here.

Target version: **Portainer CE 2.39.1** (the version running on
`carldog-nas`, confirmed via `portainer_system_status`). Pinned spec
snapshot at [`docs/specs/portainer.json`](specs/portainer.json).

## External references

The authoritative sources, in descending order of trust:

- **[Portainer source on GitHub](https://github.com/portainer/portainer)** —
  ground truth. The Swagger annotations in the source are sometimes
  wrong (we've already found three `endpointId` query params
  documented as required when the handler treats them as optional, and
  the inverse for two others — see Gotchas). When in doubt, read the
  Go handler, not the spec.
  - **Tag convention is no-`v` prefix:** `2.39.1`, not `v2.39.1`. All
    permalinks below use `2.39.1`.
  - Stack handlers: [`api/http/handler/stacks/`](https://github.com/portainer/portainer/tree/2.39.1/api/http/handler/stacks)
  - Docker proxy: [`api/http/proxy/factory/docker/`](https://github.com/portainer/portainer/tree/2.39.1/api/http/proxy/factory/docker)
  - Native Docker handlers (Portainer-specific paths): [`api/http/handler/docker/`](https://github.com/portainer/portainer/tree/2.39.1/api/http/handler/docker)
  - System endpoints: [`api/http/handler/system/`](https://github.com/portainer/portainer/tree/2.39.1/api/http/handler/system)
  - Auth: [`api/http/security/bouncer.go`](https://github.com/portainer/portainer/blob/2.39.1/api/http/security/bouncer.go)
- **[SwaggerHub `portainer/portainer-ce`](https://app.swaggerhub.com/apis/portainer/portainer-ce/)** —
  the only published spec, generated per release. Versioned (`2.39.1`,
  `2.40.0`, etc.). Direct download for a given version:
  `https://api.swaggerhub.com/apis/portainer/portainer-ce/<version>/swagger.json`
- **[docs.portainer.io](https://docs.portainer.io/)** — user docs, not
  reference material. Useful for understanding intent (e.g. "what is
  an environment" vs "what is a stack") but doesn't document the API.
- **The running instance does NOT serve a spec.** Confirmed in
  [`api/http/handler/handler.go`](https://github.com/portainer/portainer/blob/2.39.1/api/http/handler/handler.go) —
  no `/api/docs` or swagger-ui route is registered. The spec is
  generated to `dist/docs/swagger.yaml` at build time and shipped
  only via SwaggerHub.

## Spec snapshot

The pinned snapshot at [`docs/specs/portainer.json`](specs/portainer.json)
is **Swagger 2.0** (not OpenAPI 3), 441 KB, 185 paths, 345 type
definitions. Pulled from SwaggerHub `portainer/portainer-ce/2.39.1`.

**Refresh process** when the deploy target on the NAS upgrades:

1. Confirm the new version: call `portainer_system_status` (or
   `GET /api/system/status` directly) — returns `{Version, InstanceID}`.
2. Download the matching spec:

   ```bash
   curl -L -o docs/specs/portainer.json \
     https://api.swaggerhub.com/apis/portainer/portainer-ce/<version>/swagger.json
   ```

3. `git diff` shows what changed; update this doc accordingly. Pay
   attention to new endpoints under `/stacks` and `/endpoints/{id}/docker`
   that we might want to wrap, and to deprecation flags on existing
   ones.

The spec's two `securityDefinitions` are `ApiKeyAuth` (header
`X-API-KEY`) and `jwt` (header `Authorization`).

## Authentication

Portainer accepts two header-based auth methods. Confirmed in
[`api/http/security/bouncer.go`](https://github.com/portainer/portainer/blob/2.39.1/api/http/security/bouncer.go).

### `X-API-Key` header — what we use

- Header: `X-API-KEY` (case-insensitive — the bouncer also accepts
  `?X-API-KEY=` as a query string but **don't use it**: leaks into
  access logs).
- Generated in the Portainer UI: **My account → Access tokens → Add
  access token**. Per-user; admins or any user can mint their own.
- Format: `ptr_<base64-32-bytes>`. Shown **once** at creation; the DB
  stores `sha256(rawkey)` plus the 7-char prefix for UI display.
- Scope: keys inherit the **owning user's role**. There is no
  per-key permission model. portainer-mcp uses an admin's key, so
  everything is reachable; switch to a restricted user's key to
  scope down (RBAC will then filter list/inspect responses — see
  "Docker proxy" below).
- Revocation: delete in the UI. Immediate — the digest cache entry
  and DB row are removed and the next request 401s.

### JWT — UI sessions, also accepted on the API

- Obtain: `POST /api/auth` with `{username, password}`. Returns
  `{"jwt": "..."}` and sets an `HttpOnly`, `SameSite=Strict` cookie.
- Send: `Authorization: Bearer <jwt>`. Also accepted as `?token=`
  (used for websocket upgrades).
- Revocation: `POST /api/auth/logout` adds the token to an
  in-memory `revokedJWT` set. The set is **lost on Portainer
  restart** — revoked-then-restarted tokens become valid again
  until natural expiry.
- Behind LDAP/OAuth/Internal: all three back-ends terminate at
  `POST /api/auth` (or `POST /api/auth/oauth/validate` for OAuth)
  and issue a Portainer-issued JWT. External IdP tokens are not
  passed through to the API.

We use `X-API-Key` exclusively. The JWT path exists for completeness
and is not wired into the MCP.

## API versioning

- Base path: `/api`. **No version prefix on the API path itself** —
  `/api/stacks`, not `/api/v1/stacks`.
- The Docker-proxy paths under `/api/endpoints/{id}/docker/...`
  optionally accept a Docker Engine API version segment (`/v1.47/...`)
  which is regex-stripped on entry. Both `/api/endpoints/2/docker/v1.47/containers/json`
  and `/api/endpoints/2/docker/containers/json` reach the same handler.
  We omit the version.
- API surface evolves between minor Portainer versions. The pinned
  spec snapshot is the contract for the *deployed* version; refresh
  on upgrade.

## Resource model

The endpoints we care about cluster into four families:

### Endpoints (Docker hosts)

`/api/endpoints` — Portainer's term for "registered Docker host /
Swarm cluster / Kubernetes cluster." Each has a numeric `Id` and a
`Type` enum.

**`EndpointType` values** (defined in [`api/portainer.go`](https://github.com/portainer/portainer/blob/2.39.1/api/portainer.go) lines 2055-2071):

| Value | Type                                | Use Docker proxy? |
|-------|-------------------------------------|-------------------|
| 1     | `DockerEnvironment`                 | yes               |
| 2     | `AgentOnDockerEnvironment`          | yes               |
| 3     | `AzureEnvironment`                  | no (ACI path)     |
| 4     | `EdgeAgentOnDockerEnvironment`      | yes               |
| 5     | `KubernetesLocalEnvironment`        | no (k8s path)     |
| 6     | `AgentOnKubernetesEnvironment`      | no (k8s path)     |
| 7     | `EdgeAgentOnKubernetesEnvironment`  | no (k8s path)     |

**Tools that issue Docker commands should accept `{1, 2, 4}` and
refuse the rest** with a clear error. The user's only endpoint is
`Id=2, Type=2` (Docker host running an agent).

`Endpoint` shape includes `Snapshots[]` (DockerSnapshot — a cached
copy of the daemon state, can be huge). The list endpoint accepts
`?excludeSnapshots=true` and the inspect endpoint accepts
`?excludeSnapshot=true` — use both unless you specifically need the
snapshot.

`Status`: `1=up, 2=down`.

### Stacks

`/api/stacks` — Portainer's compose-stack abstraction. Each stack has
a `Type` (which orchestrator) and a `Status` (running or not).

**`Stack.Type`:**

| Value | Type            | Notes                                                              |
|-------|-----------------|--------------------------------------------------------------------|
| 1     | DockerSwarm     | Deployed via `docker stack deploy` semantics                       |
| 2     | DockerCompose   | Deployed via `docker compose up`. **All user's 36 stacks are this.** |
| 3     | Kubernetes      | Manifests applied via `kubectl`                                    |

**`Stack.Status`:** `1=Active, 2=Inactive`. Some lifecycle endpoints
refuse based on this — `POST /api/stacks/{id}/start` 400s if already
active; `/stop` 400s if already inactive.

The `EntryPoint` field names the compose file inside `ProjectPath`
(default `docker-compose.yml`). `StackFileContent` is the raw file
content as it was last written. `Env` is `[{Name, Value}]`.

### Docker proxy

`/api/endpoints/{id}/docker/...` — transparent reverse proxy to the
endpoint's Docker Engine socket, with Portainer-specific
authorization, RBAC filtering, and a few decoration fields layered
on. The version prefix in the path is regex-stripped on entry.

**Admin tokens bypass all RBAC filtering** — `restrictedResourceOperation`
short-circuits to `executeDockerRequest` when the token's role is
admin (see [`transport.go:545`](https://github.com/portainer/portainer/blob/2.39.1/api/http/proxy/factory/docker/transport.go#L545)).
The MCP runs with an admin API key by design, so the responses are
≈ raw Docker API plus a couple of Portainer-injected fields:

- `IsPortainer: true` is added to the Portainer container itself in
  list/inspect responses.
- `Portainer.ResourceControl` is injected into list/inspect responses
  for resources that have a Portainer-managed RC.
- Volumes get a synthesized `ResourceID = "<name>_<dockerID>"` so
  names are unique across endpoints.

If portainer-mcp is ever switched to a non-admin API key, list and
inspect responses will be filtered to what that user can see —
worth noting in the README if/when that day comes.

### System

`/api/system/*` — version, info, liveness.

| Endpoint                   | Auth          | Returns                                                                                       |
|----------------------------|---------------|-----------------------------------------------------------------------------------------------|
| `GET /api/system/status`   | public        | `{Version, InstanceID}` only — useful as a liveness probe                                     |
| `GET /api/system/version`  | authenticated | `{ServerVersion, ServerEdition, VersionSupport, DatabaseVersion, Build, Dependencies, UpdateAvailable, LatestVersion}` plus `Runtime` for admins |
| `GET /api/system/info`     | authenticated | `{platform, edgeAgents, agents}` — agent count over registered envs                           |
| `GET /api/status`          | public        | **Deprecated** alias for `/api/system/status`. Logs a warning. Don't rely on it.              |

Our `portainer_system_status` calls `/api/system/status` (the public
two-field one). When we want richer info, use `/api/system/version`.

## Cross-cutting patterns

### Stack deploys are SYNCHRONOUS

In Portainer 2.39.1, `composeDeploymentConfig.Deploy()` and
`swarmDeploymentConfig.Deploy()` block — the HTTP handler does not
return until the deployment manager returns. The older async pattern
(`go stackDeploy(...)`) was removed before 2.39.1.

This applies to every lifecycle endpoint:

- `PUT /api/stacks/{id}` (file-based update) — synchronous redeploy
- `PUT /api/stacks/{id}/git/redeploy` — synchronous git pull + deploy
- `POST /api/stacks/{id}/start` — synchronous up
- `POST /api/stacks/{id}/stop` — synchronous down
- `POST /api/stacks/{id}/migrate` — synchronous deploy + delete

**Implications for portainer-mcp:**

- Tool calls can take minutes for large stacks. Plan timeouts
  accordingly — the default `fetch` has no timeout, which is
  actually what we want here. Don't add a short AbortSignal.
- **Self-redeploy is awkward.** If `portainer_redeploy_stack` is
  invoked against the `portainer-mcp` stack itself, Portainer kills
  the running portainer-mcp container partway through. The MCP's
  in-flight HTTP fetch sees a connection drop and the tool call
  returns an error — even though the redeploy succeeds. Document
  this loudly in the tool description. (Self-redeploy still
  *works*; it just looks like a failure.)

### Env round-trip is required on update endpoints

Three stack-update endpoints unconditionally assign
`stack.Env = payload.Env`. **Omitting `Env` from the request body
wipes it to empty.**

Affected:

- `PUT /api/stacks/{id}` (file-based update)
- `POST /api/stacks/{id}/git` (update git config)
- `PUT /api/stacks/{id}/git/redeploy`

Plus `POST /api/stacks/{id}/git` does the same for `AutoUpdate` —
omitting it drops the auto-update schedule.

`PUT /api/stacks/{id}/git/redeploy` extends the wipe family — also
unconditionally assigned:

- `stack.GitConfig.ReferenceName = payload.RepositoryReferenceName` —
  omit and the stack's branch/tag becomes the empty string (next
  pull fails).
- For Swarm: `stack.Option = &StackOption{Prune: payload.Prune}` —
  omit and prune resets to `false`.
- For K8s: `stack.Name = payload.StackName` — omit and stack name
  becomes empty string.
- Git auth password: special case — handler reuses the saved
  password if `RepositoryPassword == ""` AND existing
  `GitConfig.Authentication != nil`. Send empty password to
  preserve the saved one (you can't read it back; responses blank
  it on the way out).

The pattern for any update tool:

1. GET the stack with raw env (bypassing the secrets redactor —
   see "Redaction vs writes" below).
2. Build the payload with the existing env + git config merged in
   unchanged.
3. PUT, sending `Env` and (for git redeploy) `RepositoryReferenceName`,
   `RepositoryAuthentication`/`RepositoryUsername`, etc. even if
   the caller didn't ask to change them.

`PortainerClient.redeployStack` and `redeployGitStack` implement
this pattern via the `noRedact: true` opt-out on `request<T>()`.

### Redaction vs writes — the `noRedact` pattern

Our `PortainerClient.request<T>()` redacts secret env values on
every JSON response (see [CLAUDE.md](../CLAUDE.md) "Conventions").
That collides with the env round-trip above: if we GET a stack and
then PUT it back, the redacted `<redacted>` strings would be sent as
the new env values, destroying every secret.

The resolution (planned, not yet implemented as of 2026-04-29): add
an opt-out flag `{ noRedact: true }` to `request<T>()`, defaulting
to `false` (redact). Internal round-trip methods opt in explicitly:

- `PortainerClient.getStackRaw(id)` — internal-only, never exposed
  as a tool. Returns the unredacted stack so update tools can
  preserve env.

Architectural rule: a single grep for `noRedact: true` should find
every callsite that sees raw secrets. Every callsite must be a
round-trip into another API call, never a path that returns data to
an MCP caller.

### Git stacks vs file stacks

Stacks have two provenance models:

- **File-based** (`GitConfig: null`) — the compose file lives in
  Portainer's data dir (`<ProjectPath>/<EntryPoint>`). Updates use
  `PUT /api/stacks/{id}` with the new `StackFileContent` in the
  body.
- **Git-based** (`GitConfig: {URL, ReferenceName, Authentication, ...}`) —
  the compose file is fetched from a git repo at deploy time.
  Updates use `PUT /api/stacks/{id}/git/redeploy` (re-pulls from
  git and re-deploys).

**Critical:** `PUT /api/stacks/{id}` (the file-based update endpoint)
**unconditionally sets `stack.GitConfig = nil`**. If you call it on a
git-managed stack, you detach it from git silently. Tools must guard:

```ts
if (stack.GitConfig != null) {
  throw new Error("Stack is git-managed — use redeploy for git stacks");
}
```

All the user's 36 stacks are file-based as of 2026-04-29.

### `PullImage` is deprecated since 2.36

The `PullImage: true` field on `PUT /api/stacks/{id}` and
`PUT /api/stacks/{id}/git/redeploy` is deprecated in favor of
`RepullImageAndRedeploy: true`. Both still work — the handler does
`payload.RepullImageAndRedeploy = payload.RepullImageAndRedeploy || payload.PullImage`.
New tools should send `RepullImageAndRedeploy`.

### Secrets in upstream responses

**Portainer does not redact env values at all.** Verified across the
entire `api/http/proxy/factory/docker/` tree — no scrub of `Env`,
`password`, `secret`, etc. The raw plaintext is forwarded.

This applies to:

- `GET /api/stacks` and `GET /api/stacks/{id}` — Stack `Env: [{Name, Value}]`
- `GET /api/endpoints/{id}/docker/containers/{id}/json` — Docker
  inspect's `Config.Env: ["KEY=VALUE", ...]`

Both shapes are scrubbed by our `redactSecrets` walker in
`PortainerClient.request<T>()`. The walker uses two parallel paths:
key-name match (regex on Env entry names) AND value-shape match
(known issuer-prefix patterns for JWT, GitHub/Stripe/Slack/AWS/
Google/Anthropic/OpenAI tokens, PEM private keys). The value-shape
path catches the case where the key name doesn't telegraph "secret"
(e.g. `BOTIFY_JWT`) but the value is unmistakably one. See CLAUDE.md
"Conventions" for the full pattern list and rationale (no generic
entropy thresholds — they false-positive on UUIDs and container IDs).
The only thing Portainer DOES sanitize is the git authentication
password on stack responses (set to `""` before serialization). Don't
rely on Portainer for env-secret hygiene — it's our problem.

### Webhooks are public

`POST /api/stacks/webhooks/{webhookID}` has **no auth** — only the
UUID itself gates access. Treat the webhook ID as a bearer token;
leakage = unauthenticated redeploy. We don't expose webhook
management as MCP tools and probably never should.

## Gotchas

### `endpointId` query param: doc says one thing, handler says another

Three patterns of mismatch found across the stacks endpoints —
**always trust the handler, not the swagger annotation:**

| Endpoint                                     | Doc      | Actual handler            |
|----------------------------------------------|----------|---------------------------|
| `PUT /api/stacks/{id}`                       | required | optional (`false`)        |
| `POST /api/stacks/{id}/git`                  | optional | **required** (`true`)     |
| `PUT /api/stacks/{id}/git/redeploy`          | optional | **required** (`true`)     |
| `POST /api/stacks/{id}/migrate`              | optional | **required** (`true`)     |
| `POST /api/stacks/{id}/start` and `/stop`    | required | optional but `0` 404s     |
| `PUT /api/stacks/{id}/associate`             | required | optional (`false`)        |

When a tool can fetch the stack first (which it usually can), use the
stack's existing `EndpointId` and don't expose the param to the
caller.

### Env field shape varies

Portainer's `/api/stacks` returns Env as `[{name, value}]` with
**lowercase** keys, but other sources (and some `Pair` definitions
in the Go source) use `Name`/`Value` capitalized. Our `scrubEnvArray`
handles both. Don't hard-code one variant when reading.

### Container logs are stream-multiplexed

`GET /api/endpoints/{id}/docker/containers/{id}/logs` returns Docker's
non-TTY stream-multiplex frames: 8-byte header per frame
(`stream_type, [3]byte_pad, length`). Portainer does not de-multiplex.
Our current `portainer_container_logs` returns the raw output;
readable but ugly. Could parse and split into stdout/stderr if it
becomes a problem.

### Compose-create silently nukes a name-collision Swarm stack

`POST /api/stacks/create/standalone/...` calls
`checkAndCleanStackDupFromSwarm` which deletes any existing **Swarm**
stack of the same name on the same endpoint (DB row + on-disk
files) before creating the new Compose stack. No warning, no
consent. Trap if a user fat-fingers `type=standalone` instead of
`type=swarm`. Tools should refuse to create when a same-name stack
already exists, regardless of type.

### Swarm "stop" is destructive, Compose "stop" is not

`POST /api/stacks/{id}/stop` semantics differ by `Stack.Type`:

- **Compose:** runs `docker compose down` — containers removed,
  volumes survive (per compose semantics).
- **Swarm:** runs `SwarmStackManager.Remove()` — services are
  **torn down entirely**. Only the DB record + files remain. Not a
  pause — closer to a destroy-and-keep-config.

Tool descriptions for any future `portainer_stop_stack` tool must
spell this out.

### Swarm "start" implicitly re-pulls images

`POST /api/stacks/{id}/start` for Swarm calls
`StackDeployer.DeploySwarmStack(..., true, true)` — both `prune` and
`pullImage` flags are unconditionally `true`. Compose start does not
pull unless the image is missing. Document the asymmetry.

### Backup .bak files can orphan on failure

Compose/Swarm update writes the new compose file in-place with a
`.bak` backup, then rolls back on deploy failure. A crash mid-write
can leave a `.bak` orphan. Worth knowing for debugging stale stack
state.

### `POST /containers/{id}/recreate` requires the full container ID

Empirically verified 2026-04-30 against a busybox compose container.
Calling recreate with the container's **name** (e.g.
`mcp-smoketest-smoketest-1`) returns:

```
500: Error recreating container — Disconnect network from old container
error: Error response from daemon: endpoint <name> not found
```

The Portainer recreate flow disconnects the old container from its
networks before swapping; that disconnect call uses the container ID
even though the inspect/lookup that preceded it accepted the name.
Result: name lookups partially succeed, then fail mid-flight with
a misleading "endpoint not found" error.

**Always pass the full 64-char Docker ID to recreate.** Tools that
accept either ID or name everywhere else (start/stop/restart/kill/inspect)
need to resolve to ID before invoking recreate.

`PortainerClient.recreateContainer` works around this by doing a
`GET /containers/{ref}/json` first to resolve any name-or-prefix
input to the canonical full ID, then calling recreate. ~50ms of
extra latency for the inspect, but the caller can pass any
container reference Docker accepts and the tool just works.

### `POST /containers/{id}/recreate` response Name has `-old` suffix

The inspect JSON returned by recreate has the new container's `Id`,
fresh `StartedAt`, and the original Config — but its `Name` field
ends in `-old` (e.g. `/mcp-smoketest-smoketest-1-old`). The actual
running container in Docker has the original name; the `-old` is
left over from Portainer's rename-then-swap implementation and never
gets cleaned up in the response shape.

If a tool surfaces the recreate response to the caller, prefer
fetching the new container by ID via `portainer_get_container`
afterward to get the canonical Name. Don't rely on the recreate
response's Name field.

### Container DNS — host can't see its own hostname

Standard rule (already covered in [CLAUDE.md](../CLAUDE.md) and the
project's docker-deployments guide): a Docker container running
portainer-mcp on the same host as Portainer can't reach Portainer
via the host's hostname (e.g. `carldog-nas:9443`). Use
`PORTAINER_URL=https://host.docker.internal:9443` and the
`extra_hosts: ["host.docker.internal:host-gateway"]` mapping in
`docker-compose.yml` (already there).

## Endpoints currently used

| Tool                          | Endpoint                                                                  | Notes                                               |
|-------------------------------|---------------------------------------------------------------------------|-----------------------------------------------------|
| `portainer_list_endpoints`    | `GET /api/endpoints`                                                      | We don't yet pass `excludeSnapshots=true` — should  |
| `portainer_list_stacks`       | `GET /api/stacks` (optional `filters={EndpointID:N}`)                     | Returns all stacks user can see                     |
| `portainer_get_stack`         | `GET /api/stacks/{id}`                                                    | Includes `Env` (redacted) and `StackFileContent`    |
| `portainer_list_containers`   | `GET /api/endpoints/{id}/docker/containers/json` (optional `?all=true`)   | Docker proxy passthrough                            |
| `portainer_get_container`     | `GET /api/endpoints/{id}/docker/containers/{id}/json`                     | Docker inspect; `Config.Env` redacted              |
| `portainer_container_logs`    | `GET /api/endpoints/{id}/docker/containers/{id}/logs?tail=N&timestamps=true` | Raw Docker stream-multiplex framing                |
| `portainer_container_start`   | `POST /api/endpoints/{id}/docker/containers/{id}/start`                   | Pure passthrough; 204 on success                    |
| `portainer_container_stop`    | `POST /api/endpoints/{id}/docker/containers/{id}/stop` (optional `?t=N`)  | Graceful SIGTERM → SIGKILL after timeout            |
| `portainer_container_restart` | `POST /api/endpoints/{id}/docker/containers/{id}/restart` (optional `?t=N`) | Same SIGTERM/wait/SIGKILL/start as stop+start      |
| `portainer_container_kill`    | `POST /api/endpoints/{id}/docker/containers/{id}/kill` (optional `?signal=`) | Skips graceful shutdown; requires `confirm: true`  |
| `portainer_recreate_container`| `POST /api/docker/{id}/containers/{id}/recreate` body `{PullImage}`       | **Native handler** (NOT under the proxy tree); `confirm: true` |
| `portainer_redeploy_stack`    | `PUT /api/stacks/{id}?endpointId=N` (after raw GET stack + GET file)      | Synchronous; refuses git stacks; `confirm: true`    |
| `portainer_redeploy_git_stack`| `PUT /api/stacks/{id}/git/redeploy?endpointId=N` (after raw GET stack)    | Synchronous; refuses non-git stacks; round-trips Env + GitConfig; `confirm: true` |
| `portainer_create_stack`      | `POST /api/stacks/create/standalone/string?endpointId=N`                  | File-based standalone Compose. Pre-flight name-collision check; `confirm: true`   |
| `portainer_create_git_stack`  | `POST /api/stacks/create/standalone/repository?endpointId=N`              | Git-managed standalone Compose. Optional auth (PAT visible in tool-call logs); `confirm: true` |
| `portainer_convert_stack_to_git` | GET stack (noRedact) → GET file (noRedact) → DELETE stack → POST create-from-repository | Atomic file→git conversion preserving env server-side; two-factor confirm; recovery payload on failure |
| `portainer_set_stack_env`     | GET stack (noRedact) → apply set/remove → PUT (file-based) or PUT git/redeploy (git-managed) | Auto-detects file vs git; triggers redeploy (env change requires container restart); `pull_image` defaults to false |
| `portainer_delete_stack`      | `DELETE /api/stacks/{id}?endpointId=N` (after GET stack to derive endpoint) | Two-factor confirm (`confirm_name` + `confirm: true`); high blast radius          |
| `portainer_system_status`     | `GET /api/system/status`                                                  | Public; `{Version, InstanceID}` only                |

All requests carry `X-API-Key: <key>` as an HTTP header
(`PortainerClient.request`). Never put the key in the URL query
string.

## Endpoints we haven't built yet

Candidates for v0.2+ with rough endpoint shapes so future-us has a
starting point. **Not endorsed, not yet investigated** — verify
against the spec snapshot and the linked handler source before
relying on the shape.

### Stack write operations

| Capability                              | Endpoint(s)                                                                                                                    | Risk class            |
|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|-----------------------|
| Start stack                             | `POST /api/stacks/{id}/start` — Swarm pulls images implicitly                                                                  | Low                   |
| Stop stack                              | `POST /api/stacks/{id}/stop` — Swarm semantics destructive                                                                     | Medium (Swarm)        |
| Create swarm stack                      | `POST /api/stacks/create/swarm/string?endpointId=N` with `{Name, SwarmID, StackFileContent, Env}`                              | Medium                |
| Update git config (no redeploy)         | `POST /api/stacks/{id}/git` — also wipes Env if omitted                                                                        | Medium                |

### Container operations

| Capability                  | Endpoint                                                                                | Risk class                        |
|-----------------------------|-----------------------------------------------------------------------------------------|-----------------------------------|
| Delete                      | `DELETE /api/endpoints/{id}/docker/containers/{id}` (optional `?force=true&v=true`)     | High                              |
| Stats                       | `GET /api/endpoints/{id}/docker/containers/{id}/stats?stream=false`                     | Low                               |
| Exec one-off command        | `POST /containers/{id}/exec` then `POST /exec/{id}/start` (HTTP hijack)                 | High (LLM RCE risk)               |

### Image operations

| Capability         | Endpoint                                                                                                     | Risk class             |
|--------------------|--------------------------------------------------------------------------------------------------------------|------------------------|
| List (Portainer)   | `GET /api/endpoints/{id}/docker/images?withUsage=true` (Portainer-specific shape, smaller than raw `/json`)  | Low                    |
| List (raw)         | `GET /api/endpoints/{id}/docker/images/json` (full Docker inspect shape)                                     | Low                    |
| Inspect            | `GET /api/endpoints/{id}/docker/images/{name}/json`                                                          | Low                    |
| Pull               | `POST /api/endpoints/{id}/docker/images/create?fromImage=...` — streaming JSONL progress                     | Medium                 |
| Remove             | `DELETE /api/endpoints/{id}/docker/images/{name}` (optional `?force=true`)                                   | Medium                 |

For image pull with private registry creds, Portainer rewrites
`X-Registry-Auth` from a registry-id reference to the actual
docker auth header. Send `X-Registry-Auth: base64(JSON({"registryId": N}))`
to use Portainer-stored credentials, or pass standard Docker auth
to forward unchanged.

### Network / volume operations

Lower priority — flag if a use case arrives.

- `GET /api/endpoints/{id}/docker/networks` and `/volumes` — list with
  Portainer RC decoration.
- `POST /networks/create`, `POST /volumes/create` — same.
- `DELETE` for both — RC cleanup on success.
- `POST /networks/{id}/connect` and `/disconnect` — attach/detach
  containers.

### System

- `GET /api/system/version` — richer than `/system/status`. Use when
  authenticated and we want build/edition info.
- `GET /api/endpoints/{id}` — confirm endpoint exists / is reachable
  before issuing Docker commands. Useful guard for write tools.

## Out of scope

Per scoping decisions: tools whose blast radius dwarfs their value
to a Claude-driven workflow.

- `DELETE /api/endpoints/{id}` — removes a registered Docker host
  from Portainer. Not destructive to the host itself, but recovering
  the registration state is annoying and there's no LLM use case
  worth that risk.
- Kubernetes write operations — `kubectl apply` semantics through
  Portainer's k8s endpoints. Out of scope for v1; user has no k8s
  endpoints.
- Edge agent management — `/edge/...` endpoints. Edge stacks have
  their own deploy + checkin lifecycle that doesn't match the
  one-shot tool model.
- User / role / team management — `POST /users`, `PUT /roles/{id}`,
  team assignments. Admin-surface ops; the LLM has no business
  promoting itself.
- Backup / restore — `POST /backup`, `POST /restore`. Operational
  concern, not workflow surface.
- `POST /api/stacks/webhooks/{webhookID}` — public endpoint, no
  auth gating beyond the UUID. Treat as a bearer token; don't
  expose webhook management.
- `POST /containers/{id}/exec` + `/exec/{id}/start` — arbitrary
  command execution inside a container. The cost of an LLM
  generating a bad command is far higher than the value of having
  the tool. If a specific scripted exec workflow becomes valuable,
  build a narrow tool around the specific command, not a general
  exec wrapper.
