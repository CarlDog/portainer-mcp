import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { PortainerClient } from "../src/portainer.js";

const canonicalId = "a".repeat(64);
const prefix = "/api/endpoints/2/docker/containers/";
const secret = "fixture-password-do-not-return";
const webhook = "fixture-webhook-do-not-return";
const logText = "2026-11-02T00:00:00Z nginx ready\n";

// Exercise the real URL construction and HTTP transport, including the raw
// log branch. An escaped request gets a secret-bearing response, reproducing
// the redaction/confirmation bypass without contacting a live Portainer.
async function withPortainer(
  run: (
    client: PortainerClient,
    requests: Array<{ method: string; url: URL }>,
  ) => Promise<void>,
  resolvedId = canonicalId,
) {
  const requests: Array<{ method: string; url: URL }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push({ method: req.method!, url });
    const containerPath = url.pathname.startsWith(prefix);
    if (containerPath && url.pathname.endsWith("/logs")) {
      const data = Buffer.from(logText);
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(data.length, 4);
      res.writeHead(200, {
        "Content-Type": "application/vnd.docker.raw-stream",
      });
      res.end(Buffer.concat([header, data]));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        containerPath
          ? {
              Id: resolvedId,
              Config: { Env: [`DB_PASSWORD=${secret}`, "MODE=production"] },
            }
          : {
              Id: 42,
              Env: [{ name: "DB_PASSWORD", value: secret }],
              Webhook: webhook,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new PortainerClient({
    url: `http://127.0.0.1:${port}`,
    apiKey: "test",
    verifyTls: true,
  });
  try {
    await run(client, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const operations = [
  {
    name: "inspect",
    method: "GET",
    suffix: "/json",
    query: "",
    call: (p: PortainerClient, id: string) => p.getContainer(2, id),
  },
  {
    name: "logs",
    method: "GET",
    suffix: "/logs",
    query: "stdout=true&stderr=true&tail=1&timestamps=true",
    call: (p: PortainerClient, id: string) => p.containerLogs(2, id, 1),
  },
  {
    name: "start",
    method: "POST",
    suffix: "/start",
    query: "",
    call: (p: PortainerClient, id: string) => p.containerStart(2, id),
  },
  {
    name: "stop",
    method: "POST",
    suffix: "/stop",
    query: "t=5",
    call: (p: PortainerClient, id: string) => p.containerStop(2, id, 5),
  },
  {
    name: "restart",
    method: "POST",
    suffix: "/restart",
    query: "t=5",
    call: (p: PortainerClient, id: string) => p.containerRestart(2, id, 5),
  },
  {
    name: "kill",
    method: "POST",
    suffix: "/kill",
    query: "signal=SIGTERM",
    call: (p: PortainerClient, id: string) => p.containerKill(2, id, "SIGTERM"),
  },
  {
    name: "delete",
    method: "DELETE",
    suffix: "",
    query: "force=true&v=true",
    call: (p: PortainerClient, id: string) =>
      p.containerDelete(2, id, { force: true, removeVolumes: true }),
  },
  {
    name: "recreate inspect",
    method: "GET",
    suffix: "/json",
    query: "",
    call: (p: PortainerClient, id: string) =>
      p.recreateContainer(2, id, { pullImage: false }),
  },
  {
    name: "env comparison",
    method: "GET",
    suffix: "/json",
    query: "",
    call: (p: PortainerClient, id: string) =>
      p.compareEnvValues(
        { endpointId: 2, containerId: id, varName: "DB_PASSWORD" },
        { endpointId: 2, containerId: id, varName: "DB_PASSWORD" },
      ),
  },
];

describe("container request path confinement", () => {
  const refs = [
    "../../../../stacks/42#",
    "../../../../stacks/42",
    "../../../../stacks/42/stop#",
    "../../volumes/persistent",
    "..\\..\\..\\..\\stacks\\42#",
    "%2e%2e/%2f..%2fstacks%2f42%23",
    "nginx?force=true#",
    "nginx#",
    "nginx\r\n/../../../../stacks/42#",
    "nginx\t/../../../../stacks/42#",
    "nginx-1",
    "Web_1.prod",
    "a",
    "0123456789ab",
    canonicalId,
    "/nginx-1",
  ];
  for (const op of operations) {
    it(`${op.name} keeps every reference in its intended container path`, async () => {
      await withPortainer(async (client, requests) => {
        for (const ref of refs) {
          requests.length = 0;
          const result = await op.call(client, ref);
          const encoded = encodeURIComponent(ref.replace(/^\//, ""));
          const firstCount = op.name === "env comparison" ? 2 : 1;
          assert.equal(
            requests.length,
            op.name === "recreate inspect" ? 2 : firstCount,
          );
          for (const request of requests.slice(0, firstCount)) {
            assert.equal(request.method, op.method, ref);
            assert.equal(
              request.url.pathname,
              `${prefix}${encoded}${op.suffix}`,
              ref,
            );
            assert.equal(request.url.searchParams.toString(), op.query, ref);
            assert.equal(request.url.hash, "", ref);
          }
          if (op.name === "recreate inspect") {
            assert.equal(requests[1].method, "POST");
            assert.equal(
              requests[1].url.pathname,
              `/api/docker/2/containers/${canonicalId}/recreate`,
            );
          }
          if (op.name === "logs") assert.equal(result, logText);
          if (op.name === "env comparison") {
            assert.deepEqual(result, {
              match: true,
              a: { found: true, empty: false },
              b: { found: true, empty: false },
            });
          }
          assert.ok(!JSON.stringify(result).includes(secret), ref);
          assert.ok(!JSON.stringify(result).includes(webhook), ref);
        }
      });
    });
  }

  it("rejects empty and dot-only references that URL encoding cannot contain", async () => {
    await withPortainer(async (client, requests) => {
      for (const op of operations) {
        for (const ref of ["", ".", "..", "/", "/.", "/.."]) {
          await assert.rejects(() => op.call(client, ref), /container_id/);
        }
      }
      assert.equal(requests.length, 0);
    });
  });

  it("redacts normal container inspect responses and stack JSON responses", async () => {
    await withPortainer(async (client) => {
      const container = await client.getContainer(2, "nginx-1");
      assert.deepEqual(container, {
        Id: canonicalId,
        Config: { Env: ["DB_PASSWORD=<redacted>", "MODE=production"] },
      });
      const stack = await client.getStack(42, { includeFile: false });
      assert.deepEqual(stack, {
        Id: 42,
        Env: [{ name: "DB_PASSWORD", value: "<redacted>" }],
        Webhook: "<redacted>",
      });
    });
  });

  it("also contains an upstream-provided recreate ID in the native endpoint", async () => {
    const resolved = "../../../../stacks/42/stop#";
    await withPortainer(async (client, requests) => {
      await client.recreateContainer(2, "nginx-1", { pullImage: false });
      assert.equal(requests.length, 2);
      assert.equal(requests[1].method, "POST");
      assert.equal(
        requests[1].url.pathname,
        `/api/docker/2/containers/${encodeURIComponent(resolved)}/recreate`,
      );
      assert.equal(requests[1].url.hash, "");
    }, resolved);
  });
});
