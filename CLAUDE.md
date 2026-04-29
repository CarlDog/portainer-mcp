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
