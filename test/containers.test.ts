import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactContainer, containerListQuery } from "../src/portainer.js";

describe("containerListQuery", () => {
  it("empty options → empty query", () => {
    assert.deepEqual(containerListQuery({}), {});
  });

  it("all=true maps to the all param", () => {
    assert.deepEqual(containerListQuery({ all: true }), { all: "true" });
  });

  it("name filter uses Docker's map-of-arrays encoding", () => {
    assert.deepEqual(containerListQuery({ name: "oc" }), {
      filters: JSON.stringify({ name: ["oc"] }),
    });
  });

  it("label filter passes key=value through", () => {
    assert.deepEqual(
      containerListQuery({ label: "com.docker.compose.project=myapp" }),
      {
        filters: JSON.stringify({
          label: ["com.docker.compose.project=myapp"],
        }),
      },
    );
  });

  it("status filter implies all=true (running-only window would silently hide matches)", () => {
    assert.deepEqual(containerListQuery({ status: "exited" }), {
      all: "true",
      filters: JSON.stringify({ status: ["exited"] }),
    });
  });

  it("combined filters land in one filters object", () => {
    const q = containerListQuery({ all: true, name: "web", status: "running" });
    assert.equal(q.all, "true");
    assert.deepEqual(JSON.parse(q.filters!), {
      name: ["web"],
      status: ["running"],
    });
  });
});

describe("compactContainer", () => {
  const fixture = {
    Id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    Names: ["/openchronicle-mcp-oc-1"],
    Image: "ghcr.io/carldog/openchronicle-mcp:latest",
    ImageID: "sha256:deadbeef",
    Command: "node dist/index.js",
    Created: 1753848000,
    State: "running",
    Status: "Up 3 days (healthy)",
    Ports: [
      { IP: "0.0.0.0", PrivatePort: 3000, PublicPort: 18000, Type: "tcp" },
      { IP: "::", PrivatePort: 3000, PublicPort: 18000, Type: "tcp" },
      { PrivatePort: 9229, Type: "tcp" },
    ],
    Labels: {
      "com.docker.compose.project": "openchronicle-mcp",
      "com.docker.compose.service": "oc",
    },
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { Networks: {} },
    Mounts: [{ Type: "volume", Name: "oc-data" }],
  };

  it("keeps the scan fields and drops the bulk", () => {
    const c = compactContainer(fixture) as Record<string, unknown>;
    assert.equal(c.Id, "0123456789ab");
    assert.deepEqual(c.Names, ["/openchronicle-mcp-oc-1"]);
    assert.equal(c.Image, "ghcr.io/carldog/openchronicle-mcp:latest");
    assert.equal(c.State, "running");
    assert.equal(c.Status, "Up 3 days (healthy)");
    assert.equal(c.Created, 1753848000);
    assert.equal("HostConfig" in c, false);
    assert.equal("NetworkSettings" in c, false);
    assert.equal("Mounts" in c, false);
    assert.equal("Labels" in c, false);
  });

  it("surfaces the compose project label that maps stack → containers", () => {
    const c = compactContainer(fixture) as Record<string, unknown>;
    assert.equal(c.ComposeProject, "openchronicle-mcp");
  });

  it("formats ports and dedupes the v4/v6 double-listing", () => {
    const c = compactContainer(fixture) as Record<string, unknown>;
    assert.deepEqual(c.Ports, [
      "0.0.0.0:18000->3000/tcp",
      ":::18000->3000/tcp",
      "9229/tcp",
    ]);
  });

  it("omits ComposeProject when the label is absent", () => {
    const noLabels: Record<string, unknown> = { ...fixture };
    delete noLabels.Labels;
    const c = compactContainer(noLabels) as Record<string, unknown>;
    assert.equal("ComposeProject" in c, false);
  });

  it("passes non-object items through untouched", () => {
    assert.equal(compactContainer(null), null);
    assert.equal(compactContainer("weird"), "weird");
  });
});
