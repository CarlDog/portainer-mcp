// REQUIRED ENFORCEMENT TEST — standard MCP-S01 / MCP-F03.
//
// A session the server no longer knows MUST answer 404, never 400.
//
// The idle sweep evicts sessions on a timer, which is correct and deliberate.
// But a client only learns to recover from a 404: the spec (2025-06-18,
// Session Management §3/§4) makes it the sole defined signal — the server
// "MUST respond to requests containing that session ID with HTTP 404 Not
// Found", and on receiving one the client "MUST start a new session by
// sending a new InitializeRequest".
//
// This shipped as a blanket 400 across six fleet servers (this repo
// included, until this test), so a routine 30-minute eviction read to the
// client as a generic protocol error and the connection stayed dead until a
// human restarted it. A comment would not have caught that. This does.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mountMcpHttp,
  type HttpTransportOptions,
} from "../src/shared/http-transport.js";

const ACCEPT = "application/json, text/event-stream";
const UNKNOWN_SESSION = "00000000-0000-0000-0000-000000000000";

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-transport-test", version: "0.0.0" },
  },
};

type Harness = { url: string; dispose: () => Promise<void> };

const live: Harness[] = [];

async function start(
  opts: Partial<HttpTransportOptions> = {},
): Promise<Harness> {
  const app = express();
  app.use(express.json());
  const mcp = mountMcpHttp(app, "/mcp", {
    createServer: () =>
      new McpServer({ name: "http-transport-test", version: "0.0.0" }),
    sessionIdleMs: 60_000,
    ...opts,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  const harness: Harness = {
    url: `http://127.0.0.1:${port}/mcp`,
    dispose: async () => {
      await mcp.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  live.push(harness);
  return harness;
}

afterEach(async () => {
  while (live.length) await live.pop()?.dispose();
});

/** Real initialize handshake. Returns the minted session id. */
async function initialize(
  url: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...extra },
    body: JSON.stringify(INIT_BODY),
  });
  assert.equal(res.status, 200);
  const id = res.headers.get("mcp-session-id");
  // The response is an SSE stream; release it so the socket does not linger.
  await res.body?.cancel();
  assert.ok(id);
  return id as string;
}

/** A post-initialize request carrying whatever session id we hand it. */
function callWithSession(
  url: string,
  sessionId: string | undefined,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
}

describe("session lifecycle", () => {
  it("initialize mints a session id", async () => {
    const { url } = await start();
    const id = await initialize(url);
    assert.match(id, /^[0-9a-f-]{36}$/i);
  });

  it("an unknown session id answers 404, not 400", async () => {
    const { url } = await start();
    const res = await callWithSession(url, UNKNOWN_SESSION);
    await res.body?.cancel();
    assert.equal(res.status, 404);
  });

  it("a session evicted by the idle sweep answers 404", async () => {
    const { url } = await start({ sessionIdleMs: 1, sweepIntervalMs: 5 });
    const id = await initialize(url);
    // Let the sweeper run at least once past the 1ms idle threshold.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const res = await callWithSession(url, id);
    await res.body?.cancel();
    assert.equal(res.status, 404);
  });

  it("a live session is still recognised", async () => {
    const { url } = await start();
    const id = await initialize(url);
    const res = await callWithSession(url, id);
    await res.body?.cancel();
    assert.notEqual(res.status, 404);
    assert.ok([200, 202].includes(res.status));
  });

  it("a non-initialize request with no session id answers 400", async () => {
    const { url } = await start();
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    await res.body?.cancel();
    assert.equal(res.status, 400);
  });
});

describe("hardening is unchanged", () => {
  it("missing or wrong bearer token answers 401", async () => {
    const { url } = await start({ authToken: "correct-horse" });

    const none = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(INIT_BODY),
    });
    await none.body?.cancel();
    assert.equal(none.status, 401);

    const wrong = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: "Bearer battery-staple",
      },
      body: JSON.stringify(INIT_BODY),
    });
    await wrong.body?.cancel();
    assert.equal(wrong.status, 401);
  });

  it("auth is checked before session handling", async () => {
    // An unknown session must not leak its 404 to an unauthenticated caller.
    const { url } = await start({ authToken: "correct-horse" });
    const res = await callWithSession(url, UNKNOWN_SESSION);
    await res.body?.cancel();
    assert.equal(res.status, 401);
  });

  it("a host outside the allowlist answers 403", async () => {
    const { url } = await start({ allowedHosts: ["allowed.example"] });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(INIT_BODY),
    });
    await res.body?.cancel();
    assert.equal(res.status, 403);
  });
});
