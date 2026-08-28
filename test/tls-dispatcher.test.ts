// Guards the actual runtime behavior test/transport.test.ts can only assert
// at the source level: that the insecure Agent dispatcher is genuinely
// honored end-to-end against a real self-signed TLS server, and that a
// verifyTls:true client genuinely rejects the same server.
//
// This is the regression class the MCP-F07 incident belongs to (a
// node:22-alpine -> node:26-alpine bump silently broke the dispatcher
// because Node's global fetch is served by its own bundled undici copy,
// distinct from the standalone npm undici package). A source-level regex
// cannot catch "the new undici major changed how the Agent options map onto
// an actual TLS handshake" -- only a real handshake can. Written specifically
// as part of the undici 6->8 migration (2026-08-28), the exact kind of bump
// this test exists to protect against regressing.
//
// Does NOT exercise ALPN/HTTP-2 negotiation (node:https only speaks
// HTTP/1.1) -- that's deliberately made moot by pinning allowH2:false on
// both PortainerClient dispatcher branches (see src/portainer.ts), not by
// this test.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import selfsigned from "selfsigned";
import { PortainerClient } from "../src/portainer.js";

describe("PortainerClient TLS dispatcher wiring", () => {
  let server: Server;
  let url: string;

  before(async () => {
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "127.0.0.1" }],
      {
        days: 1,
        keySize: 2048,
        extensions: [
          {
            name: "subjectAltName",
            altNames: [{ type: 7, ip: "127.0.0.1" }],
          },
        ],
      },
    );
    server = createServer(
      { key: pems.private, cert: pems.cert },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ Id: 1, Name: "test-endpoint" }]));
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    url = `https://127.0.0.1:${port}`;
  });

  after(() => {
    // Force-close any lingering keep-alive sockets from the client Agent(s)
    // constructed during the tests below -- a plain server.close() only
    // stops accepting new connections and waits for existing ones to end,
    // which would otherwise leave the test process hanging on an open
    // keep-alive socket.
    server.closeAllConnections();
    server.close();
  });

  it("honors the insecure dispatcher against a real self-signed server (verifyTls: false)", async () => {
    const client = new PortainerClient({
      url,
      apiKey: "test",
      verifyTls: false,
    });
    const result = await client.listEndpoints();
    assert.deepEqual(result, [{ Id: 1, Name: "test-endpoint" }]);
  });

  it("rejects the same self-signed server when verifyTls: true (insecure path stays opt-in)", async () => {
    const client = new PortainerClient({
      url,
      apiKey: "test",
      verifyTls: true,
    });
    await assert.rejects(() => client.listEndpoints());
  });
});
