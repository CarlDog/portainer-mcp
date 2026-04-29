#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { PortainerClient, registerPortainerTools } from "./portainer.js";

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

function createServer(): McpServer {
  const server = new McpServer({
    name: "portainer-mcp",
    version: "0.1.0",
  });
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

if (port) {
  // HTTP transport (long-lived server, e.g. for Portainer/Compose deployment).
  const httpApp = express();
  httpApp.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  httpApp.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Bad Request: missing or unknown session, or non-initialize POST",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  httpApp.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", transport: "http", port });
  });

  httpApp.listen(port, () => {
    console.error(`portainer-mcp HTTP transport listening on :${port}`);
  });
} else {
  // Default: stdio transport (for direct invocation by MCP clients via `docker run -i`).
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
