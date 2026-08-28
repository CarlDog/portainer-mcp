// CANONICAL SHARED FILE — standard MCP-S01 / MCP-F03. Adapted from the
// claude-fleet-kit ts-mcp-server template (logging calls adjusted to this
// repo's console.error(...) convention — no logger module here — instead of
// the template's logger(scope) factory; everything else is unchanged).
//
// Streamable HTTP transport with the four hardening measures the fleet
// survey found scattered across four different servers and complete in
// none:
//
//   1. A FRESH McpServer per session (never a shared instance).
//   2. Idle-session eviction        — only downloader-mcp had this.
//   3. Host/Origin allowlist        — missing from 3 of 7, incl. the one that
//                                     drives Docker.
//   4. Bearer auth + loopback bind  — only botify-mcp had this.

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
};

export type HttpTransportOptions = {
  /**
   * Builds a NEW McpServer with every tool registered.
   *
   * It must be a factory, not a shared instance. A single McpServer reused
   * across HTTP sessions breaks after the first one — and it works fine
   * under stdio, so light testing never catches it.
   */
  createServer: () => McpServer;
  authToken?: string | undefined;
  allowedHosts?: string[] | undefined;
  sessionIdleMs: number;
  sweepIntervalMs?: number;
};

/** Constant-time bearer comparison over SHA-256 digests. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  // Hashing first makes both sides fixed-length, so timingSafeEqual cannot
  // throw on a length mismatch — and length itself stops being an oracle.
  return timingSafeEqual(a, b);
}

/**
 * Reject requests whose Host/Origin is not allow-listed.
 *
 * Binding to loopback is NOT a control inside a container: the container's
 * loopback is its own, so the server binds 0.0.0.0 to be reachable at all,
 * and a browser on the host can then reach it via DNS rebinding — a
 * malicious page resolves its own hostname to the container IP and drives
 * the tools. The Host header check is what actually stops that. See
 * ~/.claude/rules/docker-deployments.md section 8.
 */
function hostAllowed(req: Request, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true; // not configured: open
  const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (allowed.some((h) => h.toLowerCase() === host)) return true;

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) {
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      return allowed.some((h) => h.toLowerCase() === originHost);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Mount the MCP Streamable HTTP endpoint on an Express app.
 *
 * Returns a dispose() that clears the sweep timer and closes live sessions,
 * so tests and graceful shutdown do not leak handles.
 */
export function mountMcpHttp(
  app: Express,
  path: string,
  opts: HttpTransportOptions,
): { dispose: () => Promise<void> } {
  const sessions = new Map<string, Session>();
  const sweepEvery = opts.sweepIntervalMs ?? 5 * 60_000;

  // Idle eviction. Without it a long-lived container holds every McpServer
  // ever created: clients disconnect without sending DELETE far more often
  // than they send it, so the map only grows. Deletion happens in
  // transport.onclose so there is exactly ONE removal path regardless of who
  // initiated the close.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - opts.sessionIdleMs;
    for (const [id, s] of sessions) {
      if (s.lastActivity < cutoff) {
        console.error(`portainer-mcp: evicting idle session ${id}`);
        void s.transport.close();
      }
    }
  }, sweepEvery);
  // Do not hold the event loop open just for the sweeper.
  sweep.unref?.();

  app.all(path, async (req: Request, res: Response) => {
    if (!hostAllowed(req, opts.allowedHosts)) {
      console.error(
        `portainer-mcp: rejected request, host not allowed: ${String(req.headers.host)}`,
      );
      res.status(403).json({ error: "Forbidden: host not allowed" });
      return;
    }

    if (opts.authToken) {
      const header = req.headers.authorization ?? "";
      const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!provided || !tokenMatches(provided, opts.authToken)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      existing.lastActivity = Date.now();
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    // A session id we don't recognise: evicted by the sweep above, or the
    // container restarted under a live client. The spec REQUIRES 404 here —
    // it is the client's ONLY defined signal to start a new session by
    // re-initializing (2025-06-18, Session Management §3/§4). A 400 reads as
    // a generic protocol error, so the client stays wedged until a human
    // restarts it: a routine idle eviction turns into a dead connection.
    if (sessionId) {
      res.status(404).json({ error: "Not Found: unknown or expired session" });
      return;
    }

    // No session id at all, and not an initialize POST — spec says 400.
    if (req.method !== "POST") {
      res.status(400).json({
        error: "Bad Request: non-initialize request without a session",
      });
      return;
    }

    // New session: fresh server, fresh transport.
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, server, lastActivity: Date.now() });
        console.error(
          `portainer-mcp: session initialized ${id} (live: ${sessions.size})`,
        );
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        console.error(
          `portainer-mcp: session closed ${id} (live: ${sessions.size})`,
        );
      }
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return {
    dispose: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => s.transport.close()));
      sessions.clear();
    },
  };
}
