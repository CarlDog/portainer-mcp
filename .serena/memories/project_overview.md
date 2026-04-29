# portainer-mcp — project overview

**Purpose:** MCP (Model Context Protocol) server that exposes a Portainer
instance (stacks, containers, endpoints, logs) to MCP clients
(Claude Desktop, etc.). Packaged as a Docker container.

**Status:** See `STATUS.md` in the repo root — single source of truth.

**Tech stack**
- TypeScript (Node 22+, ESM, `NodeNext` module resolution)
- `@modelcontextprotocol/sdk` v1.x — high-level `McpServer` API
- `zod` for tool input schemas
- Portainer REST API accessed directly via `fetch` (no third-party client)
- `undici` `Agent` dispatcher for optional self-signed-cert support
- Multi-stage Docker build (alpine, non-root user `mcp`)

**Transport:** dual from day one — stdio (default) + Streamable HTTP
(when `MCP_PORT` is set). Same image runs either way.

**Auth:** API key via env vars `PORTAINER_URL` + `PORTAINER_API_KEY`.
Optional `PORTAINER_VERIFY_TLS=false` to skip TLS verification (most
home Portainer setups use self-signed certs on port 9443). The
container is stateless; the API key never lands on disk.

**Repo:** https://github.com/CarlDog/portainer-mcp (public — upstream)

**Git author convention:** set the local repo author to a no-reply
email (e.g. GitHub's `<numeric-id>+<username>@users.noreply.github.com`
pattern) so personal email never lands in public commit metadata.
Configure per-repo, not globally.

**Sister projects** (deliberately consistent conventions):
- plex-mcp (https://github.com/CarlDog/plex-mcp)
- servarr-mcp (https://github.com/CarlDog/servarr-mcp)
- downloader-mcp (https://github.com/CarlDog/downloader-mcp)

**Why this exists:** Portainer's API is what we manually called to deploy
the other three MCPs (via a Python script). With portainer-mcp, future
Claude sessions can deploy/manage stacks via tool calls instead of
hand-written scripts. The MCP literally bootstraps stack management.
