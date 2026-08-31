import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeRegistryAuth, parsePullProgress } from "../src/portainer.js";

function ndjson(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

describe("parsePullProgress", () => {
  it("reports downloaded when a new image was pulled", () => {
    const raw = ndjson(
      { status: "Pulling from library/nginx", id: "1.27" },
      { status: "Pull complete", progressDetail: {}, id: "abc123" },
      { status: "Digest: sha256:deadbeef" },
      { status: "Status: Downloaded newer image for nginx:1.27" },
    );
    assert.deepEqual(parsePullProgress(raw), {
      status: "downloaded",
      statusLine: "Status: Downloaded newer image for nginx:1.27",
    });
  });

  it("reports up-to-date when nothing new was pulled", () => {
    const raw = ndjson(
      { status: "Pulling from library/nginx", id: "1.27" },
      { status: "Already exists", progressDetail: {}, id: "abc123" },
      { status: "Status: Image is up to date for nginx:1.27" },
    );
    assert.deepEqual(parsePullProgress(raw), {
      status: "up-to-date",
      statusLine: "Status: Image is up to date for nginx:1.27",
    });
  });

  it("throws on a mid-stream error object despite HTTP 200 semantics", () => {
    const raw = ndjson(
      { status: "Pulling from recyclarr/recyclarr", id: "latest" },
      {
        errorDetail: { message: "manifest unknown" },
        error: "manifest unknown",
      },
    );
    assert.throws(
      () => parsePullProgress(raw),
      /Image pull failed: manifest unknown/,
    );
  });

  it("returns unknown when no terminal status line was seen", () => {
    const raw = ndjson({ status: "Pulling from library/nginx", id: "1.27" });
    assert.deepEqual(parsePullProgress(raw), {
      status: "unknown",
      statusLine: undefined,
    });
  });

  it("returns unknown for a completely empty body", () => {
    assert.deepEqual(parsePullProgress(""), {
      status: "unknown",
      statusLine: undefined,
    });
  });

  it("tolerates a stray non-JSON line rather than failing the whole pull", () => {
    const raw =
      '{"status":"Pulling from library/nginx","id":"1.27"}\n' +
      "not json at all\n" +
      '{"status":"Status: Downloaded newer image for nginx:1.27"}\n';
    assert.deepEqual(parsePullProgress(raw), {
      status: "downloaded",
      statusLine: "Status: Downloaded newer image for nginx:1.27",
    });
  });

  it("ignores blank lines between progress objects", () => {
    const raw =
      '{"status":"Pulling from library/nginx"}\n\n\n' +
      '{"status":"Status: Image is up to date for nginx:latest"}\n';
    assert.deepEqual(parsePullProgress(raw), {
      status: "up-to-date",
      statusLine: "Status: Image is up to date for nginx:latest",
    });
  });

  it("takes the last terminal status line when more than one appears", () => {
    // Shouldn't happen in practice, but the parser should be deterministic
    // rather than silently picking the first one it saw.
    const raw = ndjson(
      { status: "Status: Downloaded newer image for nginx:1.26" },
      { status: "Status: Downloaded newer image for nginx:1.27" },
    );
    assert.equal(
      parsePullProgress(raw).statusLine,
      "Status: Downloaded newer image for nginx:1.27",
    );
  });
});

describe("encodeRegistryAuth", () => {
  it("encodes only the Portainer stored-registry reference", () => {
    assert.equal(encodeRegistryAuth(1), "eyJyZWdpc3RyeUlkIjoxfQ==");
    assert.deepEqual(
      JSON.parse(
        Buffer.from(encodeRegistryAuth(42), "base64").toString("utf8"),
      ),
      { registryId: 42 },
    );
  });

  it("rejects invalid registry IDs at the client boundary", () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => encodeRegistryAuth(value),
        /registry_id must be a positive safe integer/,
      );
    }
  });
});
