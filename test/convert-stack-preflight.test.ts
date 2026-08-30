import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { PortainerClient } from "../src/portainer.js";

describe("convertStackToGit repository preflight", () => {
  it("rejects an unreachable target before reading recovery YAML or deleting the source", async () => {
    const requests: string[] = [];
    let previewBody: Record<string, unknown> | undefined;
    let deleted = false;

    const server: Server = createServer(async (req, res) => {
      const requestKey = `${req.method} ${req.url}`;
      requests.push(requestKey);

      if (requestKey === "GET /api/stacks/42") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            Id: 42,
            Type: 2,
            EndpointId: 2,
            Name: "source-stack",
            Env: [],
            GitConfig: null,
          }),
        );
        return;
      }

      if (requestKey === "POST /api/gitops/repo/file/preview") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        previewBody = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as Record<string, unknown>;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "repository preview rejected" }));
        return;
      }

      if (requestKey === "DELETE /api/stacks/42?endpointId=2") {
        deleted = true;
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
      await assert.rejects(
        () =>
          client.convertStackToGit(42, {
            repositoryUrl: "https://github.com/example/private-repo",
            composePath: "deploy/docker-compose.yml",
            gitCredentialId: 7,
            confirmName: "source-stack",
          }),
        /Git repository preflight failed before stack "source-stack" was changed/,
      );
      assert.deepEqual(requests, [
        "GET /api/stacks/42",
        "POST /api/gitops/repo/file/preview",
      ]);
      assert.equal(deleted, false);
      assert.deepEqual(previewBody, {
        repository: "https://github.com/example/private-repo",
        reference: "refs/heads/main",
        targetFile: "deploy/docker-compose.yml",
        TLSSkipVerify: false,
        authorizationType: 0,
        gitCredentialID: 7,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
