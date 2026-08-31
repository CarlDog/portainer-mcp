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

31 tools: 13 read tools plus 18 write tools with real side effects
(container lifecycle, stack create/update/redeploy/delete). Secrets in
Portainer/Docker responses are redacted client-side before reaching MCP
callers; see [STATUS.md](STATUS.md) for scope details and known gaps.
All input schemas enforce `.strict()` — an unknown or misspelled param
name is rejected with a clear error rather than silently dropped.

Redeploy/recreate tools never prune images implicitly. A dangling digest
may be an intentional rollback point, so inspect with
`portainer_list_images` and call confirm-gated `portainer_prune_images`
separately when cleanup is explicitly wanted.

### Read

| Tool | Description |
| --- | --- |
| `portainer_list_endpoints` | List all Portainer environments (compact by default; full=true for raw JSON including per-endpoint Snapshots) |
| `portainer_list_stacks` | List stacks (compact by default; endpoint/name filters; full=true for raw JSON) |
| `portainer_get_stack` | Stack details by ID, including compose file content (`include_file=false` to skip it) |
| `portainer_list_containers` | List containers (compact by default; name/label/status filters; full=true for raw JSON) |
| `portainer_get_container` | Container details (state, config, env, ports, mounts); compact by default, full=true for raw inspect JSON |
| `portainer_compare_env_values` | Check whether two containers' env values are equal, without exposing either one |
| `portainer_container_logs` | Demuxed container logs bounded by tail/since/until, with optional literal or isolated timeout-bounded regex filtering |
| `portainer_list_volumes` | List Docker volumes in an endpoint |
| `portainer_inspect_volume` | Volume details by name |
| `portainer_list_networks` | List Docker networks in an endpoint |
| `portainer_inspect_network` | Network details by ID/name |
| `portainer_list_images` | List Docker images in an endpoint, with per-image usage info |
| `portainer_system_status` | Portainer version + system info |

### Write (side effects — use deliberately)

| Tool | Description |
| --- | --- |
| `portainer_container_start` | Start a stopped container |
| `portainer_container_stop` | Gracefully stop a container |
| `portainer_container_restart` | Restart a container |
| `portainer_container_kill` | SIGKILL a container (not graceful) |
| `portainer_container_delete` | Delete a container (irreversible; force=true to delete a running one) |
| `portainer_delete_volume` | Permanently delete one exact dangling volume (irreversible; two-factor name confirmation; never forced) |
| `portainer_recreate_container` | Recreate a container (optionally re-pull image); preserves dangling rollback images |
| `portainer_pull_image` | Pull an image without touching any container; optionally reference a Portainer-stored private-registry credential by `registry_id` |
| `portainer_create_stack` | Create a new compose stack from a file body |
| `portainer_create_git_stack` | Create a git-managed stack from a repository; optional AutoUpdate polling |
| `portainer_update_stack_file` | Replace a stack's compose file content; image pruning remains explicit |
| `portainer_set_stack_env` | Set/update a stack's environment variables; warns if a set key isn't referenced in the compose file |
| `portainer_redeploy_stack` | Redeploy a file-based stack (apply config changes); image pruning remains explicit |
| `portainer_redeploy_git_stack` | Re-pull and redeploy a git-managed stack; image pruning remains explicit |
| `portainer_convert_stack_to_git` | Convert a file-based stack to git-managed; optional AutoUpdate polling |
| `portainer_set_git_auth` | Update git credentials on a git-managed stack |
| `portainer_delete_stack` | Delete a stack and all its containers |
| `portainer_prune_images` | Bulk-delete unused images (dangling-only by default, or all-unused) |
| `portainer_prune_networks` | Remove all Docker networks not used by any container |

## Configuration

| Var | Required | Notes |
| --- | --- | --- |
| `PORTAINER_URL` | yes | e.g. `https://nas.local:9443` (HTTPS) or `http://nas.local:9000` |
| `PORTAINER_API_KEY` | yes | Generate in Portainer: *My Account → API Keys* |
| `PORTAINER_VERIFY_TLS` | no | `false` to skip TLS verification (self-signed certs). Default `true`. |
| `MCP_PORT` | no | Set to enable HTTP transport. Unset = stdio. |
| `MCP_BIND_HOST` | no | HTTP transport bind address. Default `127.0.0.1`; `docker-compose.yml` sets `0.0.0.0` (required for the port mapping to work at all). |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated Host/Origin allowlist for the HTTP transport (DNS-rebinding defense). Unset = any host accepted. `docker-compose.yml` defaults to `localhost` — set it to your deployment host's real hostname(s) via Portainer's stack env, or real clients get a 403. |
| `MCP_AUTH_TOKEN` | no | Bearer token required on the HTTP transport, on top of the host allowlist. Unset = no auth check (startup logs a warning). Set via the Portainer UI, not committed anywhere. |
| `MCP_SESSION_IDLE_MS` | no | HTTP transport idle-session eviction cutoff, ms. Default `1800000` (30 min). |

## Transport modes

| Mode | When to use | How to start |
| --- | --- | --- |
| **stdio** (default) | Direct invocation by Claude Desktop / MCP clients | `docker run -i --rm ...` (no `MCP_PORT`) |
| **Streamable HTTP** | Long-lived deployment (Portainer, Compose, k8s) | Set `MCP_PORT=3000` (already done in `docker-compose.yml`) |

In HTTP mode the server exposes:
- `POST/GET/DELETE /mcp` — MCP Streamable HTTP endpoint (per spec)
- `GET /health` — liveness probe (used by docker healthcheck; unauthenticated by design)

HTTP mode enforces a **Host/Origin allowlist** (`MCP_ALLOWED_HOSTS`) by
default in `docker-compose.yml` — binding `0.0.0.0` is not itself a
control inside a container (DNS rebinding can still reach it), so the
allowlist is the actual defense. **Bearer auth** (`MCP_AUTH_TOKEN`) is an
optional second layer, off by default — add it via Portainer once you're
ready. Idle HTTP sessions are evicted automatically after
`MCP_SESSION_IDLE_MS`.

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
   optionally `PORTAINER_VERIFY_TLS`, `HOST_PORT`. Also set
   `MCP_ALLOWED_HOSTS` to the hostname(s) real clients will use to reach
   this stack (the compose default is `localhost`-only) — and optionally
   `MCP_AUTH_TOKEN` for bearer auth.
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
- HTTP transport enforces a Host/Origin allowlist (`MCP_ALLOWED_HOSTS`) by
  default, with optional bearer auth (`MCP_AUTH_TOKEN`) as a second layer —
  see "Transport modes" above.
- Found a vulnerability? See [SECURITY.md](SECURITY.md) for how to
  report it privately.
