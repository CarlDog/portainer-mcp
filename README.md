# portainer-mcp

<!-- fleet-confidence -->
![code confidence](https://img.shields.io/badge/code_confidence-fair-orange) <sub>· `claude-opus-4-8[1m]` · 2026-07-07 · [details](https://github.com/CarlDog/portainer-mcp/issues/1)</sub>
<!-- /fleet-confidence -->


An [MCP](https://modelcontextprotocol.io) server for
[Portainer](https://www.portainer.io/) — exposes stacks, containers,
endpoints, and container logs to MCP clients (Claude Desktop, etc.).
Packaged as a Docker container, with both stdio and Streamable HTTP
transports.

Sister to [`plex-mcp`](https://github.com/CarlDog/plex-mcp),
[`servarr-mcp`](https://github.com/CarlDog/servarr-mcp), and
[`downloader-mcp`](https://github.com/CarlDog/downloader-mcp).

## Tools

All read-only in this version. Write operations (deploy/redeploy,
container start/stop/restart) are deliberately deferred to a later release.

| Tool | Description |
| --- | --- |
| `portainer_list_endpoints` | List all Portainer environments (Docker hosts/Swarms) |
| `portainer_list_stacks` | List stacks (optionally filtered by endpoint) |
| `portainer_get_stack` | Stack details (compose, env, status) by ID |
| `portainer_list_containers` | List containers in an endpoint (optional all=true) |
| `portainer_get_container` | Container details (state, config, networks, mounts) |
| `portainer_container_logs` | Tail of container logs (1-5000 lines) |
| `portainer_system_status` | Portainer version + system info |

## Configuration

| Var | Required | Notes |
| --- | --- | --- |
| `PORTAINER_URL` | yes | e.g. `https://nas.local:9443` (HTTPS) or `http://nas.local:9000` |
| `PORTAINER_API_KEY` | yes | Generate in Portainer: *My Account → API Keys* |
| `PORTAINER_VERIFY_TLS` | no | `false` to skip TLS verification (self-signed certs). Default `true`. |
| `MCP_PORT` | no | Set to enable HTTP transport. Unset = stdio. |

## Transport modes

| Mode | When to use | How to start |
| --- | --- | --- |
| **stdio** (default) | Direct invocation by Claude Desktop / MCP clients | `docker run -i --rm ...` (no `MCP_PORT`) |
| **Streamable HTTP** | Long-lived deployment (Portainer, Compose, k8s) | Set `MCP_PORT=3000` (already done in `docker-compose.yml`) |

In HTTP mode the server exposes:
- `POST/GET/DELETE /mcp` — MCP Streamable HTTP endpoint (per spec)
- `GET /health` — liveness probe (used by docker healthcheck)

> HTTP mode currently has **no auth**. Bind only to a private network.
> Don't expose to the public internet without adding a bearer token.

## Run with Docker (stdio, on demand)

```bash
docker build -t portainer-mcp .
docker run -i --rm \
  -e PORTAINER_URL=https://nas.local:9443 \
  -e PORTAINER_API_KEY=ptr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  -e PORTAINER_VERIFY_TLS=false \
  portainer-mcp
```

## Run with Docker Compose (HTTP, long-lived)

The compose file pulls `ghcr.io/carldog/portainer-mcp:latest`, published
by CI on each push to `main`.

```bash
export PORTAINER_URL=https://nas.local:9443
export PORTAINER_API_KEY=ptr_...
export PORTAINER_VERIFY_TLS=false
export HOST_PORT=3004  # optional, defaults to 3004

docker compose up
```

The MCP endpoint will be at `http://<host>:${HOST_PORT}/mcp`.

## Deploy via Portainer (Stack from Git)

1. In Portainer, *Stacks → Add Stack → Repository*.
2. Repository URL: `https://github.com/CarlDog/portainer-mcp`
3. Compose path: `docker-compose.yml`
4. Environment variables: set `PORTAINER_URL`, `PORTAINER_API_KEY`,
   optionally `PORTAINER_VERIFY_TLS`, `HOST_PORT`.
5. Deploy. Healthcheck reaches green within ~10 seconds.

> **Self-reference note:** if you deploy this on the same Portainer
> instance the MCP targets, the API key needs permission to read its
> own host. That's typical — admin tokens or appropriate role tokens work.

## Use with Claude Desktop

### stdio (local invocation)

```json
{
  "mcpServers": {
    "portainer": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "PORTAINER_URL", "-e", "PORTAINER_API_KEY", "-e", "PORTAINER_VERIFY_TLS",
        "portainer-mcp"
      ],
      "env": {
        "PORTAINER_URL": "https://nas.local:9443",
        "PORTAINER_API_KEY": "ptr_...",
        "PORTAINER_VERIFY_TLS": "false"
      }
    }
  }
}
```

### HTTP (remote MCP server)

```json
{
  "mcpServers": {
    "portainer": {
      "url": "http://nas.local:3004/mcp"
    }
  }
}
```

## Local development

```bash
npm install
cp .env.example .env  # then edit
PORTAINER_URL=... PORTAINER_API_KEY=... PORTAINER_VERIFY_TLS=false npm run dev
```

## Security

- Container runs as a non-root user (`mcp`).
- API key passed via env var — never baked into the image.
- A `.githooks/pre-commit` runs gitleaks (secrets) and a PII pattern
  check (user-home paths, personal-domain emails). Activate it once
  per clone: `git config core.hooksPath .githooks`.
- HTTP transport has no auth — bind to private networks only.
