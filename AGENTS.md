# portainer-mcp

MCP server for Portainer (stacks, containers, endpoints), packaged as a
Docker container.

## Status

Single source of truth: [STATUS.md](STATUS.md). Do not duplicate status
into this file, MEMORY.md, or Serena memories — reference STATUS.md.

## Current Sprint

See [STATUS.md](STATUS.md) for the active phase, what's done, and
what's next.

## Stack

- TypeScript (Node 22+, ESM, `NodeNext` module resolution)
- `@modelcontextprotocol/sdk` (high-level `McpServer` API)
- `zod` for tool input schemas
- Portainer REST API accessed directly via `fetch` (no third-party client)
- `undici` `Agent` for optional self-signed-cert support
- Docker multi-stage build (alpine, non-root user `mcp`)

## Layout

- `src/index.ts` — MCP server entry. Reads env vars at startup,
  decides transport based on `MCP_PORT`. Per-session `McpServer`
  instances via the `createServer()` factory.
- `src/shared/http-transport.ts` — canonical fleet-wide HTTP transport
  hardening (`mountMcpHttp`): bearer auth, Host/Origin allowlist,
  idle-session eviction, spec-correct 404-on-unknown-session. Copied
  near-verbatim from plex-mcp/kindroid-mcp's MCP-F03 template — see
  "Transport modes" below and the file's own header comment before
  editing it.
- `src/portainer.ts` — `PortainerClient` (X-API-Key auth, optional
  insecure dispatcher for self-signed Portainer certs), the shared pure
  helper functions (redaction, compaction, diffing, warnings), and the
  thin `registerPortainerTools` orchestrator that delegates to
  `src/tools/*.ts`.
- `src/tools/` — MCP tool registrations, one file per Portainer
  resource: `stacks.ts`, `containers.ts`, `images.ts`, `networks.ts`,
  `volumes.ts`, `system.ts`. See "Tool registration layout" below.
- `src/util.ts` — `asText()` helper.
- `Dockerfile` — multi-stage build (alpine, non-root user).
- `docker-compose.yml` — Compose/Portainer deployment using HTTP transport.
- `.githooks/pre-commit` — gitleaks + PII pattern scan.
- `docs/PORTAINER-API.md` — API reference for the deployed Portainer
  version. Read before adding tools that wrap new endpoints.
- `docs/specs/portainer.json` — pinned Swagger 2.0 spec snapshot for
  the deployed Portainer version. Refresh when Portainer is upgraded
  on the NAS (process documented in `PORTAINER-API.md`).

## Tool registration layout

**Split by resource (2026-08-28).** `src/portainer.ts` had grown to
~3000 lines (pure helpers + `PortainerClient` + 31 inline tool
registrations); the file-size finding from the 2026-08-19 phase-end
audit was the trigger. All 31 `server.registerTool(...)` calls moved
into six `src/tools/<resource>.ts` files — `stacks.ts` (11 tools,
~590 lines), `containers.ts` (10, ~385), `images.ts` (3, ~75),
`networks.ts` (3, ~80), `volumes.ts` (2, ~60), `system.ts` (2, ~45).
Each exports a single `register<Resource>Tools(server, p)`, called
from `registerPortainerTools` in `src/portainer.ts` — that function is
now a thin orchestrator, not a 1200-line body. `PortainerClient`, the
pure helper functions (`redactSecrets`, `compactStack`,
`withEnvWarnings`, etc.), and `registerPortainerTools` itself all stay
in `src/portainer.ts` — both the client and the pure helpers are
shared across every `src/tools/*.ts` file, so moving them would invert
the dependency direction (tools depend on the client, never the
reverse). `src/index.ts` is unaffected; `registerPortainerTools`'s
name, signature, and location didn't change.

`stacks.ts` runs over the ~300-400 line soft cap from
phase-end-audit.md, but it's one logical concern (stack lifecycle)
sharing the GET→mutate→PUT round-trip pattern across every write tool
— legitimate cohesion, not a junk drawer, so it wasn't split further.

**Next trigger, if it arrives:** a tool that orchestrates across
multiple Portainer resources (e.g. "redeploy all stacks whose images
are stale" — list stacks + inspect each + redeploy) or does non-trivial
cross-resource composition doesn't belong in any single
`src/tools/<resource>.ts` file or in `PortainerClient` — that's when a
`src/tools/orchestration.ts` (or similar) becomes the next addition.
Don't pre-split for it.

## Transport modes

The same image supports two transports, selected at start time:

- **stdio (default)** — used when `MCP_PORT` is unset. Server reads
  MCP wire from stdin and writes to stdout. Standard mode for
  `docker run -i` invocation by an MCP client.
- **HTTP (Streamable HTTP)** — used when `MCP_PORT` is set to a port
  number. Server listens on `$MCP_BIND_HOST:$MCP_PORT` (default bind
  `127.0.0.1`; `docker-compose.yml` sets `0.0.0.0`, required for the
  published port to work at all) with two endpoints:
  - `POST/GET/DELETE /mcp` — MCP Streamable HTTP per spec, mounted via
    `mountMcpHttp()` in `src/shared/http-transport.ts`; per-session
    `mcp-session-id` header.
  - `GET /health` — liveness probe (used by docker healthcheck;
    unauthenticated by design, same as every sibling MCP).

  Per-session `McpServer` instances via `createServer()`; the
  `PortainerClient` is module-scope (no per-session state).

  **HTTP hardening (2026-08-28, closes both open phase-end-audit
  findings at once).** `mountMcpHttp()` provides, in one place:
  - **Host/Origin allowlist** (`MCP_ALLOWED_HOSTS`, comma-separated) —
    the actual DNS-rebinding defense; binding `0.0.0.0` is not itself a
    control inside a container (docker-deployments.md section 8). Unset
    = open (any host); `docker-compose.yml` defaults to `localhost`-only,
    so a real deployment must set this via Portainer's stack env or
    every request 403s. A value that IS set but parses to zero usable
    entries throws at startup rather than silently going open — see
    `parseAllowedHosts()` in `src/index.ts`.
  - **Bearer auth** (`MCP_AUTH_TOKEN`) — optional second layer on top of
    the allowlist, constant-time-compared over SHA-256 digests. Unset =
    no auth check, logged as a startup warning. Set via the Portainer
    UI only — never as a tool input or committed value (same principle
    as "Secrets in tool INPUTS" below).
  - **Idle-session eviction** (`MCP_SESSION_IDLE_MS`, default 30 min) —
    a periodic sweep closes sessions past the cutoff via
    `transport.onclose`, the single removal path regardless of who
    initiated the close.
  - **Spec-correct 404 on an unknown/expired session id** (previously a
    blanket 400) — the client's *only* defined signal (2025-06-18,
    Session Management §3/§4) to re-initialize; a 400 reads as a generic
    protocol error and leaves the client wedged until a human restarts
    it. `test/http-transport.test.ts` enforces this directly.
  - Graceful shutdown (`SIGTERM`/`SIGINT`) now disposes the sweep timer
    and closes live sessions before exit — the old code had no shutdown
    handling at all.

## Common Commands

```bash
npm install            # install deps
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (requires PORTAINER_URL, PORTAINER_API_KEY)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run format         # prettier --write .
docker build -t portainer-mcp .
```

## Conventions

- **`package.json` is `@carldog/portainer-mcp` and `private: true` — both
  deliberate.** The unscoped name `portainer-mcp` was still free, but three
  fleet repos lost theirs to unrelated packages before anyone thought to
  check; a scope is reserved to the account, so no name inside it can be
  taken. Nothing here publishes to npm: this ships as a container
  (`ghcr.io/carldog/portainer-mcp`), there is no publish workflow and no
  `NPM_TOKEN`, and `private: true` blocks an accidental publish while `bin`
  + `files` advertise a publishable shape. If npx distribution is ever
  wanted, drop the flag and add `"publishConfig": {"access": "public"}` —
  scoped packages default to private, so a first publish without it fails
  with a 402.

- All logging goes to **stderr** (`console.error`). stdout is the MCP
  wire protocol — writing to it corrupts the transport.
- Tool names: `portainer_<verb_noun>` (e.g. `portainer_list_stacks`).
  Always snake_case.
- Tool inputs validated with `zod`. Outputs returned as a single
  JSON-stringified text content block via `asText()`.
- Auth via env vars `PORTAINER_URL` + `PORTAINER_API_KEY`. The
  container is stateless; the API key never lands on disk in the image.
- HTTP mode enforces a **Host/Origin allowlist** by default
  (`MCP_ALLOWED_HOSTS`) and supports optional **bearer auth**
  (`MCP_AUTH_TOKEN`) — see "Transport modes" above. Binding to a
  private network is still good practice, but is no longer the only
  control.
- **Secrets in upstream responses are redacted before returning to
  MCP callers.** Portainer's `/api/stacks` and `/api/stacks/{id}` (and
  the Docker `inspect` proxy at
  `/api/endpoints/{id}/docker/containers/{id}/json`) return the full
  `Env` arrays with values in plaintext. `PortainerClient.request<T>()`
  runs the `redactSecrets` walker on every JSON response: any property
  named `Env`/`env` (case-insensitive) whose value is an array gets
  scrubbed. Two parallel detection paths — an entry is redacted if
  EITHER fires:
  - **Key-name match.** Env keys matching
    `(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$|jwt|bearer|credential|dsn|url|uri|conn|pwd?$)`
    have their values replaced with `<redacted>`; keys are never
    altered. The `url|uri|conn` tokens cover connection strings
    (`DATABASE_URL`, `MONGO_URI`, `PG_CONN`) that commonly inline
    credentials.
  - **Value-shape match.** Even when the key name doesn't telegraph
    "secret" (e.g. `BOTIFY_JWT`, `SESSION_DATA`), the value is
    redacted if it matches one of `SECRET_VALUE_PATTERNS` —
    high-confidence issuer prefixes that don't appear in non-secret
    values: JWT (`eyJ...`), GitHub PATs (`ghp_`, `github_pat_`),
    Stripe (`sk_live_`, `pk_test_`, etc.), Anthropic / OpenAI
    (`sk-`, `sk-ant-`), Slack (`xox[baprs]-`), AWS (`AKIA`, `ASIA`),
    Google (`AIza`), PEM `-----BEGIN ... PRIVATE KEY-----`
    markers, and URLs with inline credentials
    (`scheme://user:pass@host`). We deliberately avoid generic
    entropy/length thresholds
    because UUIDs, content hashes, and Docker container IDs would
    false-positive — config the LLM legitimately needs to read.

  Handles both wire shapes — Portainer's `[{Name, Value}, …]` (or
  lowercase) and Docker inspect's `["KEY=VALUE", …]`.

  **Architectural invariant — don't bypass `request<T>()`.** The
  redactor lives in the JSON branch of `request<T>()`. Any new client
  method that calls `fetch` directly skips the redactor silently. If
  you need special handling (binary body, streaming, non-JSON
  content type) extend `request<T>()` rather than adding a parallel
  fetch path. The current exception is `containerLogs`, which goes
  through `request<T>()` but takes the text branch — logs are
  app-controlled output, not config, and aren't expected to contain
  structured secrets.

  **Opt-out for round-trip writes — `{ noRedact: true }`.**
  `request<T>()` accepts an optional `{ noRedact: true }` flag that
  skips the JSON redactor. Use it ONLY when the response is fed
  immediately into another API call and never returned to an MCP
  caller — e.g. `redeployStack` GETs the stack with `noRedact: true`
  so it can PUT the real env back (the affected stack-update
  endpoints unconditionally assign `stack.Env = payload.Env`, so
  posting the redacted shape would wipe the real secrets — see
  [PORTAINER-API.md](docs/PORTAINER-API.md) "Env round-trip is
  required"). A single `grep -rn "noRedact: true" src/` should find
  every callsite — security review checks that each one is a true
  internal round-trip, never a path that reaches the MCP wire.

  **Known limitation:** `portainer_get_stack` returns
  `StackFileContent` (raw compose YAML). The redactor only scrubs
  structured `Env` arrays, not arbitrary YAML — so secrets inlined
  in compose files (rather than referenced via `${VAR}`) will still
  surface. Use stack-level env vars + `${VAR}` references in compose
  to stay covered. See STATUS.md Known Gaps.

  **Stack `Webhook` field (2026-08-19).** A stack's `Webhook` property
  is a UUID that triggers an unauthenticated public redeploy
  (`POST /stacks/webhooks/{id}` — see [PORTAINER-API.md](docs/PORTAINER-API.md)
  "Webhooks are public"). It's a bearer token, not a display value, but
  it's a top-level scalar field, not an `Env` array entry, so it sat
  outside the redactor's scope until now — `portainer_list_stacks` and
  `portainer_get_stack` were returning it in plaintext. `redactSecrets`
  now special-cases any key named `webhook` (case-insensitive, at any
  nesting depth) the same way it special-cases `env`: a non-empty
  string value becomes `<redacted>`; an empty string (no webhook
  configured) isn't secret and passes through unchanged, so callers can
  still tell whether a stack has one enabled.

  **Comparing two redacted secrets — `portainer_compare_env_values`
  (2026-08-19).** Redaction is correct but creates its own gap: two
  services that are supposed to share a value (e.g. a shared bearer
  token) can't be checked for equality by eyeballing two
  `portainer_get_container`/`portainer_get_stack` results, since both
  show `<redacted>` regardless of whether the underlying values match.
  This tool fetches both raw values server-side (`noRedact`), hashes
  them (SHA-256, constant-time compare), and returns only
  `match: true/false` plus `found`/`empty` flags per side — never the
  values, never a hash. Deliberately stateless (no hash is stored) to
  match this codebase's existing stateless design — see STATUS.md
  "Design Principles" for why a store-hash-at-write-time variant was
  considered and rejected in favor of this on-demand version.

- **Secrets in tool INPUTS, not just outputs.** The redactor above
  protects responses Portainer returns to us; it does NOT protect
  secrets the user passes INTO tools as parameters. Three existing
  tools accept a credential param (`portainer_set_git_auth`,
  `portainer_create_git_stack`, `portainer_convert_stack_to_git` —
  all take an optional `password` for git auth). Anything passed to
  these lands in the conversation transcript, tool-call log, and any
  session persistence (Codex Desktop history, OpenChronicle, etc.).
  The Portainer UI's password field is more ephemeral than chat.
  Therefore: **prefer the Portainer UI for credential rotation**,
  use these tools sparingly with scoped easy-to-rotate PATs, and
  **don't add new tools that take secrets as input by default**
  (e.g. registry credential update, named git credential CRUD —
  keep those as UI operations). See STATUS.md "Design Principles"
  for the full reasoning.
  - **Better option for `create_git_stack` / `convert_stack_to_git`:
    `git_credential_id` (2026-08-19).** Both tools now accept an
    optional `git_credential_id`, referencing an existing credential
    stored in Portainer (Settings > Git credentials), as an
    alternative to `username`/`password`. Nothing secret transits
    the tool call at all — the credential lives server-side in
    Portainer, referenced only by its numeric id. Mutually exclusive
    with `username`/`password`; both client methods validate this
    up front (before `convertStackToGit`'s delete step, specifically,
    so a bad combination refuses cleanly instead of deleting the
    source first). Wire field is `RepositoryGitCredentialID`
    (PascalCase, matches the read-side `GitConfig.Authentication.
    GitCredentialID` shape) — confirmed by reading Portainer's own
    served frontend bundle and live-verified against CE 2.39.6 with
    a throwaway create-stack call using a deliberately nonexistent
    compose path (so no container could ever be created regardless
    of outcome). No portainer-mcp tool currently lists available
    credential ids — the caller needs to know the id from the
    Portainer UI (Settings > Git credentials) today.

## Self-signed certs

Home Portainer setups commonly use self-signed certs on port 9443.
Set `PORTAINER_VERIFY_TLS=false` in the env to skip cert verification.
Implementation uses `undici.Agent({ connect: { rejectUnauthorized: false } })`
as the per-request `dispatcher` — surgical, doesn't affect other fetches.
Default is to verify (secure default).

## Tool surface

31 tools registered in `src/portainer.ts` — 13 read tools (endpoints,
stacks, containers, logs, volumes, networks, images, system status,
env-value comparison) and 18 write tools (container start/stop/restart/
kill/delete/recreate; image pull; stack create/update/env/redeploy/git-convert/
delete; git auth; image and network prune). The v1 "read-only initial
scope" is history — see STATUS.md for the authoritative per-tool
chronology and the README for the current tool table.

**All 31 tool `inputSchema`s enforce `.strict()`** — an unknown or
misspelled input key is rejected with a clear "unrecognized key" error
at the MCP validation layer instead of being silently stripped (zod's
default raw-shape behavior) and surfacing later as a confusing
"required field missing" error. Verified through a real client/server
round-trip (not just source-reading) that this SDK version accepts a
full `z.object({...}).strict()` in place of a raw shape for
`inputSchema`, and that both the advertised JSON schema
(`additionalProperties: false`) and runtime parsing honor it — unlike
object-level `.refine()`/`.superRefine()`, which mcp-server-authoring.md
documents as silently dropped by the same mechanism (a `.strict()`
ZodObject still exposes `.shape`, which is what the SDK's schema
normalizer keys off; a `.refine()` wrapper's `ZodEffects` doesn't).

Write tools have real blast radius (`portainer_delete_stack` removes a
stack and all its containers; `portainer_container_kill` is SIGKILL).
Tool descriptions should make severity explicit so MCP clients can
prompt for confirmation appropriately.

**Auto-prune on redeploy/recreate.** `portainer_redeploy_stack`,
`portainer_update_stack_file`, `portainer_redeploy_git_stack`, and
`portainer_recreate_container` each call `pruneDanglingAfterRedeploy`
(`PortainerClient`) once their main call succeeds, and merge the result
onto the response as `imagePrune` via `withImagePrune`. This is the
actual answer to "clean up orphaned images" — it targets the moment an
image digest actually becomes orphaned (a redeploy swapping the tag to
a new digest), not a time-based schedule. Always dangling-only (never
`allUnused`); the aggressive mode stays an explicit, separately-
confirmed call to `portainer_prune_images`. A prune failure is caught
and reported in `imagePrune.error` rather than failing the redeploy
that already succeeded — the redeploy is the thing that matters here.
Known gap: a stack redeploy triggered by Portainer's own git-auto-update
polling (no MCP call involved) doesn't go through these tools, so it
isn't covered by this mechanism.

**Second known gap — self-redeploy (confirmed live 2026-08-18).**
Redeploying portainer-mcp's *own* stack doesn't get the auto-prune: the
redeploy replaces the very container whose process is handling that
request, and the process is killed as part of the swap before it reaches
the `pruneDanglingAfterRedeploy` call — same root cause as the
documented in-flight-connection-drop quirk on these tools' descriptions.
Redeploying any *other* stack is unaffected (that calling process stays
alive to finish the request). Mitigation: after a portainer-mcp
self-redeploy, follow up with one manual `portainer_prune_images` call.
See STATUS.md for the live-verified details.

## Testing

- `npm test` — `node --test` (via tsx) over `test/*.test.ts`. One file
  per pure-function area (`redact`, `containers`, `env-compare`,
  `images`, `http-transport`, `env-warnings`, `compact-projections`,
  `demux-logs`, `container-changes`, `prune-warning`, `pull-progress`,
  `transport`, `version-sync`) — table-driven unit tests against pure
  functions extracted from the client/tool layer, no mocking involved.
- For anything that talks to Portainer, prefer integration tests
  against a real instance behind env-gated tests (don't mock — see
  working-style note about mocked-vs-real divergence).

## MCP tooling (local workstation)

This repo's Codex sessions use two MCP servers:

- **Serena** — user-scoped (available in every project on this machine).
  Project memories are written under the `portainer-mcp` Serena project.
- **OpenChronicle** — user-scoped HTTP transport pointing at the NAS
  deployment at `http://your-nas:18000/mcp/` (Portainer stack 151,
  image `ghcr.io/carldog/openchronicle-mcp`). One container, one DB,
  shared across every project. The trailing slash on `/mcp/` matters —
  the server 307-redirects without it. Register with:
  `Codex mcp add --transport http --scope user openchronicle http://your-nas:18000/mcp/`.

**Do not run a local `oc serve` or save via the local `oc` CLI.** The
local binary still exists on the workstation but its SQLite DB is not
authoritative — anything written there is invisible to MCP tools and
to other workstations. NAS-only is the rule.

The project_id for this repo on the NAS OC is
`5e12a080-0f4d-405c-a2c6-86026f6aae49`. `memory_save` calls must pass
that as `project_id` (FK; freeform strings fail). `project_list` lookup
by name is the resilient way to resolve it if the ID drifts.
