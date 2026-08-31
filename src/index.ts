#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express, { type Request, type Response } from "express";
import { PortainerClient, registerPortainerTools } from "./portainer.js";
import { mountMcpHttp } from "./shared/http-transport.js";
import { SERVER_VERSION } from "./shared/version.js";

const PORTAINER_URL = process.env.PORTAINER_URL;
const PORTAINER_API_KEY = process.env.PORTAINER_API_KEY;
const PORTAINER_VERIFY_TLS =
  (process.env.PORTAINER_VERIFY_TLS ?? "true").toLowerCase() !== "false";

if (!PORTAINER_URL || !PORTAINER_API_KEY) {
  console.error(
    "PORTAINER_URL and PORTAINER_API_KEY environment variables are required",
  );
  process.exit(1);
}

const portainer = new PortainerClient({
  url: PORTAINER_URL,
  apiKey: PORTAINER_API_KEY,
  verifyTls: PORTAINER_VERIFY_TLS,
});

const INSTRUCTIONS = `MCP server for Portainer (Docker stack & container management). Read tools (list/get/inspect, container logs, system status) and write tools (start/stop/restart/kill containers, create/delete/redeploy stacks, set stack env, recreate containers, convert stacks between git-managed and file-based deployment).

Idioms:
- Most tools take an endpoint_id — the Portainer environment ID. Use portainer_list_endpoints first if you don't know it; for typical home setups it's 2 (the local Docker socket).
- Stack env values returned by portainer_list_stacks and portainer_get_stack (and Docker inspect Config.Env via portainer_get_container) are scrubbed at the client — values that look like secrets come back as "<redacted>". Real values must be fetched from Portainer's UI directly; the MCP intentionally won't expose them.
- Write tools have side effects of varying severity:
  - portainer_container_restart / _start / _stop are reversible.
  - portainer_container_kill is SIGKILL (not graceful).
  - portainer_delete_stack removes the stack and all its containers.
  - portainer_redeploy_stack (or _redeploy_git_stack) is the standard "apply config changes" flow after editing env vars or compose.
  Confirm with the user before invoking any mutation tool unless intent is unambiguous.

Auth: Portainer API key via PORTAINER_API_KEY env var (X-API-Key header). Optional PORTAINER_VERIFY_TLS=false for self-signed certs (typical home setup).`;

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "portainer-mcp",
      version: SERVER_VERSION,
    },
    {
      instructions: INSTRUCTIONS,
    },
  );
  registerPortainerTools(server, portainer);
  return server;
}

console.error(
  `portainer-mcp: target=${PORTAINER_URL} verify_tls=${PORTAINER_VERIFY_TLS}`,
);

const portStr = process.env.MCP_PORT;
const port = portStr ? Number.parseInt(portStr, 10) : null;
if (portStr && (port === null || Number.isNaN(port))) {
  console.error(`Invalid MCP_PORT: ${portStr}`);
  process.exit(1);
}

/**
 * Comma-separated allowlist backing a safety control. A value that IS set
 * but parses to zero usable entries throws rather than yielding [] —
 * hostAllowed() in shared/http-transport.ts treats an empty array as "not
 * configured: open", so a typo that empties the list would otherwise
 * silently disable the exact control it was meant to enable. Matching there
 * is hostname-only (the Host header's port is split off, Origin's
 * URL.hostname carries none), so a host:port entry could never match —
 * strip one trailing :<digits> suffix per entry, but only when the
 * remainder holds no other colon, so an IPv6 literal is never mangled into
 * a different (still unmatchable) entry.
 */
function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .map((s) => s.replace(/^([^:]*):\d+$/, "$1"))
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(
      "MCP_ALLOWED_HOSTS is set but contains no usable entries. Leave it " +
        "unset to allow any host, or an empty value would disable this " +
        "safety control by accident.",
    );
  }
  return items;
}

if (port) {
  // HTTP transport (long-lived server, e.g. for Portainer/Compose deployment).
  const bindHost = process.env.MCP_BIND_HOST?.trim() || "127.0.0.1";
  const allowedHosts = parseAllowedHosts(
    process.env.MCP_ALLOWED_HOSTS?.trim() || undefined,
  );
  const authToken = process.env.MCP_AUTH_TOKEN?.trim() || undefined;

  const rawSessionIdle = process.env.MCP_SESSION_IDLE_MS?.trim();
  const sessionIdleMs = rawSessionIdle ? Number(rawSessionIdle) : 30 * 60_000;
  if (!Number.isFinite(sessionIdleMs) || sessionIdleMs <= 0) {
    console.error(
      `MCP_SESSION_IDLE_MS must be a positive number (got: ${rawSessionIdle})`,
    );
    process.exit(1);
  }

  const httpApp = express();
  httpApp.use(express.json());

  const mcp = mountMcpHttp(httpApp, "/mcp", {
    createServer,
    authToken,
    allowedHosts,
    sessionIdleMs,
  });

  httpApp.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", transport: "http", port });
  });

  // Express 5's app.listen() wraps this callback with once() and registers
  // it as the server's own 'error' listener, so a bind failure (e.g. a
  // stale container still bound to the port during a Portainer manual
  // recreate -- docker-deployments.md section 4) now calls back with an
  // Error instead of the Express 4 behavior of throwing it as an uncaught
  // exception. Without this check, a port collision would silently log a
  // false "listening" line while nothing is actually bound, instead of the
  // loud crash Docker's restart policy is designed to act on.
  const httpServer = httpApp.listen(port, bindHost, (err?: Error) => {
    if (err) {
      console.error(
        `portainer-mcp: failed to bind ${bindHost}:${port}: ${err.message}`,
      );
      process.exit(1);
    }
    console.error(
      `portainer-mcp HTTP transport listening on ${bindHost}:${port} ` +
        `(auth=${authToken ? "bearer" : "none"}, ` +
        `allowed_hosts=${allowedHosts?.join(",") ?? "any"})`,
    );
    if (!authToken) {
      console.error(
        "portainer-mcp: MCP_AUTH_TOKEN is unset — the HTTP endpoint accepts unauthenticated requests",
      );
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`portainer-mcp: shutting down (${signal})`);
    await mcp.dispose();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} else {
  // Default: stdio transport (for direct invocation by MCP clients via `docker run -i`).
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
