import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PortainerClient, registerPortainerTools } from "../src/portainer.js";

const FULL_ID = "a".repeat(64);
const ENV_VALUE = "fixture-private-env-value";
const WEBHOOK = "fixture-private-webhook";

type ContainerCase = {
  name: string;
  args: (id: string) => Record<string, unknown>;
};

// The comparison tool has two independent container_id inputs. Exercise both
// through MCP parsing rather than assuming a shared helper covers each site.
const containerCases: ContainerCase[] = [
  ...[
    "get_container",
    "container_logs",
    "container_start",
    "container_stop",
    "container_restart",
    "container_kill",
    "container_delete",
    "recreate_container",
  ].map((name) => ({
    name: `portainer_${name}`,
    args: (id: string) => ({
      endpoint_id: 2,
      container_id: id,
      ...(["container_kill", "container_delete", "recreate_container"].includes(
        name,
      )
        ? { confirm: true }
        : {}),
    }),
  })),
  ...(["a", "b"] as const).map((side) => ({
    name: "portainer_compare_env_values",
    args: (id: string) => ({
      a: { endpoint_id: 2, container_id: "nginx-1", var_name: "DB_PASSWORD" },
      b: { endpoint_id: 2, container_id: "nginx-1", var_name: "DB_PASSWORD" },
      [side]: { endpoint_id: 2, container_id: id, var_name: "DB_PASSWORD" },
    }),
  })),
];

async function start() {
  const requests: string[] = [];
  const upstream = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url!, "http://fixture.invalid");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && url.pathname === "/api/stacks/42") {
      res.end(
        JSON.stringify({
          Id: 42,
          Name: "protected-stack",
          EndpointId: 2,
          Env: [{ name: "DB_PASSWORD", value: ENV_VALUE }],
          Webhook: WEBHOOK,
        }),
      );
    } else if (
      req.method === "GET" &&
      url.pathname === "/api/endpoints/2/docker/volumes/protected-volume"
    ) {
      res.end(JSON.stringify({ Name: "protected-volume" }));
    } else if (
      req.method === "GET" &&
      url.pathname === "/api/endpoints/2/docker/volumes"
    ) {
      res.end(JSON.stringify({ Volumes: [] }));
    } else if (req.method === "GET" && url.pathname.endsWith("/json")) {
      res.end(
        JSON.stringify({
          Id: FULL_ID,
          Name: "/nginx-1",
          Config: { Env: [`DB_PASSWORD=${ENV_VALUE}`, "MODE=production"] },
          State: { Status: "running" },
          Webhook: WEBHOOK,
        }),
      );
    } else if (req.method === "GET" && url.pathname.endsWith("/logs")) {
      res.setHeader("Content-Type", "text/plain");
      res.end("ordinary container log\n");
    } else if (req.method === "POST" && url.pathname.endsWith("/recreate")) {
      res.end(JSON.stringify({ Id: FULL_ID }));
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const { port } = upstream.address() as AddressInfo;
  const portainer = new PortainerClient({
    url: `http://127.0.0.1:${port}`,
    apiKey: "test",
    verifyTls: true,
  });
  const server = new McpServer({
    name: "container-boundaries",
    version: "0.0.0",
  });
  registerPortainerTools(server, portainer);
  const client = new Client({ name: "container-boundaries", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const dispose = async () => {
    await client.close();
    await server.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  };
  live.push(dispose);
  return { client, requests };
}

const live: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (live.length) await live.pop()?.();
});

describe("container identifier MCP boundaries", () => {
  it("advertises the shared constraint for every container_id input", async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    let identifiers = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (key === "container_id") {
          assert.deepEqual(
            {
              type: entry.type,
              minLength: entry.minLength,
              pattern: entry.pattern,
            },
            {
              type: "string",
              minLength: 1,
              pattern: "^\\/?[A-Za-z0-9][A-Za-z0-9_.-]*$",
            },
          );
          identifiers++;
        }
        visit(entry);
      }
    };
    for (const tool of tools) visit(tool.inputSchema);
    assert.equal(identifiers, 10);
  });

  it("rejects URL syntax at all ten inputs before making any upstream request", async () => {
    const { client, requests } = await start();
    const invalid = [
      "",
      ".",
      "..",
      "../nginx-1",
      "../../../../stacks/42#",
      "../../../../stacks/42",
      "../volumes/protected-volume",
      "../../../../stacks/42/stop#",
      "nginx-1/json#",
      "nginx-1?force=true",
      "nginx-1#",
      "nginx-1\\..\\..",
      "%2e%2e%2f%2e%2e%2fstacks%2f42%23",
      "%252e%252e%252fstacks%252f42%2523",
      "//nginx-1",
      "/../nginx-1",
      "nginx-1/",
      " nginx-1",
      "nginx-1\n",
    ];
    for (const entry of containerCases) {
      for (const id of invalid) {
        const result = await client.callTool({
          name: entry.name,
          arguments: entry.args(id),
        });
        assert.equal(
          result.isError,
          true,
          `${entry.name}: ${JSON.stringify(id)}`,
        );
        assert.match(JSON.stringify(result), /container_id/);
      }
    }
    assert.deepEqual(requests, []);
  });

  it("accepts IDs and names at every input and normalizes Docker's leading slash", async () => {
    const { client, requests } = await start();
    for (const entry of containerCases) {
      for (const id of [
        "nginx-1",
        "A_name.2-3",
        "a",
        "abc123def456",
        FULL_ID,
        "/nginx-1",
      ]) {
        requests.length = 0;
        const result = await client.callTool({
          name: entry.name,
          arguments: entry.args(id),
        });
        assert.notEqual(
          result.isError,
          true,
          `${entry.name}: ${id}: ${JSON.stringify(result)}`,
        );
        assert.ok(requests.length > 0);
        assert.ok(
          requests.some(
            (request) =>
              request.includes(`/containers/${id.replace(/^\//, "")}/`) ||
              request.endsWith(`/containers/${id.replace(/^\//, "")}`),
          ),
        );
        assert.ok(
          requests.every(
            (request) =>
              !request.includes("/containers//") && !request.includes("%2F"),
          ),
        );
      }
    }
  });

  it("keeps secrets redacted on inspect and exposes only comparison flags", async () => {
    const { client } = await start();
    const inspected = await client.callTool({
      name: "portainer_get_container",
      arguments: { endpoint_id: 2, container_id: "/nginx-1", full: true },
    });
    assert.notEqual(inspected.isError, true);
    assert.match(JSON.stringify(inspected), /DB_PASSWORD=<redacted>/);
    assert.match(JSON.stringify(inspected), /<redacted>/);
    assert.doesNotMatch(
      JSON.stringify(inspected),
      new RegExp(`${ENV_VALUE}|${WEBHOOK}`),
    );
    const compared = await client.callTool({
      name: "portainer_compare_env_values",
      arguments: containerCases[8]!.args("/nginx-1"),
    });
    assert.notEqual(compared.isError, true);
    assert.doesNotMatch(
      JSON.stringify(compared),
      new RegExp(`${ENV_VALUE}|${WEBHOOK}`),
    );
    assert.ok("content" in compared);
    const text = compared.content.find((block) => block.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text), {
      match: true,
      a: { found: true, empty: false },
      b: { found: true, empty: false },
    });
  });

  it("still requires explicit confirmation for kill, delete and recreate", async () => {
    const { client, requests } = await start();
    for (const name of [
      "portainer_container_kill",
      "portainer_container_delete",
      "portainer_recreate_container",
    ]) {
      for (const confirm of [undefined, false]) {
        const result = await client.callTool({
          name,
          arguments: {
            endpoint_id: 2,
            container_id: "nginx-1",
            ...(confirm === undefined ? {} : { confirm }),
          },
        });
        assert.equal(result.isError, true, name);
        assert.match(JSON.stringify(result), /confirm/);
      }
    }
    assert.deepEqual(requests, []);
  });

  it("keeps stack name confirmation and volume dangling checks on their own tools", async () => {
    const { client, requests } = await start();
    for (const [name, args] of [
      ["portainer_delete_stack", { stack_id: 42, confirm: true }],
      [
        "portainer_delete_volume",
        { endpoint_id: 2, volume_name: "protected-volume", confirm: true },
      ],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /confirm_name/);
    }
    assert.deepEqual(requests, []);

    const stackResult = await client.callTool({
      name: "portainer_delete_stack",
      arguments: { stack_id: 42, confirm: true, confirm_name: "wrong-stack" },
    });
    assert.equal(stackResult.isError, true);
    assert.match(JSON.stringify(stackResult), /Name mismatch/);
    const volumeResult = await client.callTool({
      name: "portainer_delete_volume",
      arguments: {
        endpoint_id: 2,
        volume_name: "protected-volume",
        confirm: true,
        confirm_name: "protected-volume",
      },
    });
    assert.equal(volumeResult.isError, true);
    assert.match(JSON.stringify(volumeResult), /not currently dangling/);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.startsWith("GET ")));
  });
});
