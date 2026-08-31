import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { PortainerClient } from "../src/portainer.js";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("convertStackToFile", () => {
  it("preserves raw env server-side while replacing a git-managed Compose stack", async () => {
    const requests: string[] = [];
    let createBody: Record<string, unknown> | undefined;

    const server: Server = createServer(async (req, res) => {
      const requestKey = `${req.method} ${req.url}`;
      requests.push(requestKey);

      if (requestKey === "GET /api/stacks/181") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            Id: 181,
            Type: 2,
            EndpointId: 2,
            Name: "kindroid-mcp",
            Env: [{ name: "MCP_AUTH_TOKEN", value: "test-secret" }],
            GitConfig: { URL: "https://github.com/example/private" },
          }),
        );
        return;
      }
      if (requestKey === "GET /api/stacks/181/file") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            StackFileContent:
              "services:\n  app:\n    image: example/app:latest\n",
          }),
        );
        return;
      }
      if (requestKey === "DELETE /api/stacks/181?endpointId=2") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (
        requestKey ===
        "GET /api/stacks?filters=%7B%22EndpointID%22%3A2%7D"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      if (
        requestKey ===
        "POST /api/stacks/create/standalone/string?endpointId=2"
      ) {
        createBody = await readJson(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: 201, Name: "kindroid-mcp" }));
        return;
      }

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `unexpected request: ${requestKey}` }));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const client = new PortainerClient({
      url: `http://127.0.0.1:${port}`,
      apiKey: "test",
      verifyTls: true,
    });

    try {
      const result = await client.convertStackToFile(181, {
        confirmName: "kindroid-mcp",
      });
      assert.deepEqual(requests, [
        "GET /api/stacks/181",
        "GET /api/stacks/181/file",
        "DELETE /api/stacks/181?endpointId=2",
        "GET /api/stacks?filters=%7B%22EndpointID%22%3A2%7D",
        "POST /api/stacks/create/standalone/string?endpointId=2",
      ]);
      assert.deepEqual(createBody, {
        Name: "kindroid-mcp",
        StackFileContent:
          "services:\n  app:\n    image: example/app:latest\n",
        Env: [{ name: "MCP_AUTH_TOKEN", value: "test-secret" }],
      });
      assert.deepEqual(result, {
        ok: true,
        action: "convert_stack_to_file",
        source_stack_id: 181,
        name: "kindroid-mcp",
        endpoint_id: 2,
        git_management_removed: true,
        stack: { Id: 201, Name: "kindroid-mcp" },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("refuses an empty checked-out compose before deleting the source", async () => {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
      const requestKey = `${req.method} ${req.url}`;
      requests.push(requestKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        requestKey === "GET /api/stacks/181"
          ? JSON.stringify({
              Id: 181,
              Type: 2,
              EndpointId: 2,
              Name: "kindroid-mcp",
              Env: [],
              GitConfig: {},
            })
          : JSON.stringify({ StackFileContent: "" }),
      );
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const client = new PortainerClient({
      url: `http://127.0.0.1:${port}`,
      apiKey: "test",
      verifyTls: true,
    });

    try {
      await assert.rejects(
        () =>
          client.convertStackToFile(181, {
            confirmName: "kindroid-mcp",
          }),
        /returned an empty compose file/,
      );
      assert.deepEqual(requests, [
        "GET /api/stacks/181",
        "GET /api/stacks/181/file",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
