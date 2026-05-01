# portainer-mcp

MCP server for Portainer (stacks, containers, endpoints), packaged as a
Docker container.

## Status

Single source of truth: [STATUS.md](STATUS.md). Do not duplicate status
into this file, MEMORY.md, or Serena memories — reference STATUS.md.

## Current Sprint

**Phase: scaffolding** — see [STATUS.md](STATUS.md) for the active
phase, what's done, and what's next.

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
- `src/portainer.ts` — `PortainerClient` (X-API-Key auth, optional
  insecure dispatcher for self-signed Portainer certs) +
  `registerPortainerTools`.
- `src/util.ts` — `asText()` helper.
- `Dockerfile` — multi-stage build (alpine, non-root user).
- `docker-compose.yml` — Compose/Portainer deployment using HTTP transport.
- `.githooks/pre-commit` — gitleaks + PII pattern scan.
- `docs/PORTAINER-API.md` — API reference for the deployed Portainer
  version. Read before adding tools that wrap new endpoints.
- `docs/specs/portainer.json` — pinned Swagger 2.0 spec snapshot for
  the deployed Portainer version. Refresh when Portainer is upgraded
  on the NAS (process documented in `PORTAINER-API.md`).

## When to add a `tools/` layer

Today the structure is flat: `src/portainer.ts` holds the API client
and the MCP tool registrations. That's idiomatic when each tool is a
thin wrapper over a single Portainer API call.

**Trigger to refactor:** the first tool that doesn't fit cleanly inline.
Concretely:

- A tool that **orchestrates across multiple Portainer resources** —
  e.g. "redeploy all stacks whose images are stale" (list stacks +
  inspect each + redeploy). That doesn't belong inside the client.
- A tool that does **non-trivial composition** of multiple API calls —
  filtering, ranking, cross-referencing.

When that arrives, pull tool registrations out into
`src/tools/<descriptive-name>.ts`. Don't pre-split.

## Transport modes

The same image supports two transports, selected at start time:

- **stdio (default)** — used when `MCP_PORT` is unset. Server reads
  MCP wire from stdin and writes to stdout. Standard mode for
  `docker run -i` invocation by an MCP client.
- **HTTP (Streamable HTTP)** — used when `MCP_PORT` is set to a port
  number. Server listens on `0.0.0.0:$MCP_PORT` with two endpoints:
  - `POST/GET/DELETE /mcp` — MCP Streamable HTTP per spec; per-session
    `mcp-session-id` header.
  - `GET /health` — liveness probe (used by docker healthcheck).

  Per-session `McpServer` instances via `createServer()`; the
  `PortainerClient` is module-scope (no per-session state).

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

- All logging goes to **stderr** (`console.error`). stdout is the MCP
  wire protocol — writing to it corrupts the transport.
- Tool names: `portainer_<verb_noun>` (e.g. `portainer_list_stacks`).
  Always snake_case.
- Tool inputs validated with `zod`. Outputs returned as a single
  JSON-stringified text content block via `asText()`.
- Auth via env vars `PORTAINER_URL` + `PORTAINER_API_KEY`. The
  container is stateless; the API key never lands on disk in the image.
- HTTP mode has **no MCP auth** — bind only to private networks.
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
    `(?i)(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$|jwt|bearer|credential|dsn)`
    have their values replaced with `<redacted>`; keys are never
    altered.
  - **Value-shape match.** Even when the key name doesn't telegraph
    "secret" (e.g. `BOTIFY_JWT`, `SESSION_DATA`), the value is
    redacted if it matches one of `SECRET_VALUE_PATTERNS` —
    high-confidence issuer prefixes that don't appear in non-secret
    values: JWT (`eyJ...`), GitHub PATs (`ghp_`, `github_pat_`),
    Stripe (`sk_live_`, `pk_test_`, etc.), Anthropic / OpenAI
    (`sk-`, `sk-ant-`), Slack (`xox[baprs]-`), AWS (`AKIA`, `ASIA`),
    Google (`AIza`), and PEM `-----BEGIN ... PRIVATE KEY-----`
    markers. We deliberately avoid generic entropy/length thresholds
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

## Self-signed certs

Home Portainer setups commonly use self-signed certs on port 9443.
Set `PORTAINER_VERIFY_TLS=false` in the env to skip cert verification.
Implementation uses `undici.Agent({ connect: { rejectUnauthorized: false } })`
as the per-request `dispatcher` — surgical, doesn't affect other fetches.
Default is to verify (secure default).

## Initial scope (read-only)

7 tools, all read-only:

- `portainer_list_endpoints` — Docker hosts/Swarms registered with Portainer
- `portainer_list_stacks` — Stacks (optionally per-endpoint)
- `portainer_get_stack` — Stack details by ID
- `portainer_list_containers` — Containers in an endpoint (optional all=true)
- `portainer_get_container` — Container details by ID/name
- `portainer_container_logs` — Tail of container logs (1-5000 lines)
- `portainer_system_status` — Portainer version + system info

Write operations (deploy/update/remove stacks, restart/stop containers)
are deliberately out of scope for v1. They are higher blast-radius and
warrant explicit consent flows. Add after smoke tests prove the read
path is solid.

## Testing

No tests yet. When added, integration tests against a real Portainer
instance behind env-gated tests (don't mock — see working-style note
about mocked-vs-real divergence).

## MCP tooling (local workstation)

This repo is registered with two MCP servers for Claude Code sessions
opened in this directory:

- **Serena** — user-scoped (available in every project on this machine).
  Project memories are written under the `portainer-mcp` Serena project.
- **OpenChronicle** — registered at *local scope* for this directory
  via `claude mcp add openchronicle -- oc mcp serve`. Effective for
  future Claude Code sessions opened with cwd = repo root. Config lives
  in `~/.claude.json` under the project entry — not committed.

If you re-clone the repo on another machine, re-register OpenChronicle
with the same command. Serena will work automatically if it's already
user-scoped on that machine.
