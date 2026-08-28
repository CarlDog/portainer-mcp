import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactContainerInspect,
  compactEndpoint,
  compactStack,
  filterStacksByName,
} from "../src/portainer.js";

describe("filterStacksByName", () => {
  const stacks = [
    { Id: 1, Name: "plex-mcp" },
    { Id: 2, Name: "servarr-mcp" },
    { Id: 3, Name: "PLEX-companion" },
  ];

  it("matches a case-insensitive substring", () => {
    assert.deepEqual(filterStacksByName(stacks, "plex"), [
      stacks[0],
      stacks[2],
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    assert.deepEqual(filterStacksByName(stacks, "nope"), []);
  });

  it("skips non-object / nameless entries without throwing", () => {
    assert.deepEqual(filterStacksByName([null, "weird", { Id: 4 }], "x"), []);
  });
});

describe("compactStack", () => {
  const fixture = {
    Id: 129,
    Name: "portainer-mcp",
    Type: 2,
    EndpointId: 2,
    Status: 1,
    CreationDate: 1753000000,
    Env: [{ name: "TOKEN", value: "<redacted>" }],
    GitConfig: { URL: "https://github.com/CarlDog/portainer-mcp" },
    Option: { Prune: false },
    ResourceControl: { Id: 5 },
  };

  it("keeps the summary fields and drops the bulk", () => {
    const s = compactStack(fixture) as Record<string, unknown>;
    assert.equal(s.Id, 129);
    assert.equal(s.Name, "portainer-mcp");
    assert.equal(s.Type, 2);
    assert.equal(s.EndpointId, 2);
    assert.equal(s.Status, 1);
    assert.equal(s.CreationDate, 1753000000);
    assert.equal("Env" in s, false);
    assert.equal("GitConfig" in s, false);
    assert.equal("Option" in s, false);
    assert.equal("ResourceControl" in s, false);
  });

  it("derives GitManaged: true when GitConfig is present", () => {
    const s = compactStack(fixture) as Record<string, unknown>;
    assert.equal(s.GitManaged, true);
  });

  it("derives GitManaged: false for a file-based stack (GitConfig null)", () => {
    const fileStack = { ...fixture, GitConfig: null };
    const s = compactStack(fileStack) as Record<string, unknown>;
    assert.equal(s.GitManaged, false);
  });

  it("passes non-object items through untouched", () => {
    assert.equal(compactStack(null), null);
    assert.equal(compactStack("weird"), "weird");
  });
});

describe("compactContainerInspect", () => {
  const fixture = {
    Id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    Name: "/openchronicle-mcp-oc-1",
    Created: "2026-01-01T00:00:00Z",
    RestartCount: 0,
    State: { Status: "running", Running: true, ExitCode: 0 },
    Config: {
      Image: "ghcr.io/carldog/openchronicle-mcp:latest",
      Env: ["FOO=bar", "TOKEN=<redacted>"],
      Labels: {
        "com.docker.compose.project": "openchronicle-mcp",
        "com.docker.compose.service": "oc",
      },
    },
    NetworkSettings: {
      Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "18000" }] },
      Networks: { bridge: { IPAddress: "172.17.0.2" } },
      Gateway: "172.17.0.1",
    },
    Mounts: [
      {
        Type: "volume",
        Name: "oc-data",
        Source: "/var/lib/docker/volumes/oc-data/_data",
        Destination: "/data",
        RW: true,
        Driver: "local",
        Mode: "z",
      },
    ],
    HostnamePath: "/var/lib/docker/containers/abc/hostname",
    HostsPath: "/var/lib/docker/containers/abc/hosts",
    GraphDriver: { Name: "overlay2", Data: {} },
  };

  it("keeps the full Id (unlike compactContainer's list-view truncation)", () => {
    const c = compactContainerInspect(fixture) as Record<string, unknown>;
    assert.equal(c.Id, fixture.Id);
  });

  it("keeps Env — inspecting a single container is when config matters", () => {
    const c = compactContainerInspect(fixture) as Record<string, unknown>;
    assert.deepEqual(c.Env, ["FOO=bar", "TOKEN=<redacted>"]);
  });

  it("keeps State, Created, RestartCount, Image, Ports, and a trimmed Mounts", () => {
    const c = compactContainerInspect(fixture) as Record<string, unknown>;
    assert.deepEqual(c.State, fixture.State);
    assert.equal(c.Created, fixture.Created);
    assert.equal(c.RestartCount, 0);
    assert.equal(c.Image, "ghcr.io/carldog/openchronicle-mcp:latest");
    assert.deepEqual(c.Ports, fixture.NetworkSettings.Ports);
    assert.deepEqual(c.Mounts, [
      { Source: fixture.Mounts[0].Source, Destination: "/data", RW: true },
    ]);
  });

  it("drops low-value NetworkSettings/GraphDriver/path noise", () => {
    const c = compactContainerInspect(fixture) as Record<string, unknown>;
    assert.equal("GraphDriver" in c, false);
    assert.equal("HostnamePath" in c, false);
    assert.equal("HostsPath" in c, false);
    assert.equal("NetworkSettings" in c, false);
  });

  it("surfaces the compose project label", () => {
    const c = compactContainerInspect(fixture) as Record<string, unknown>;
    assert.equal(c.ComposeProject, "openchronicle-mcp");
  });

  it("passes non-object items through untouched", () => {
    assert.equal(compactContainerInspect(null), null);
    assert.equal(compactContainerInspect("weird"), "weird");
  });
});

describe("compactEndpoint", () => {
  const fixture = {
    Id: 2,
    Name: "local",
    Type: 1,
    URL: "unix:///var/run/docker.sock",
    Status: 1,
    GroupId: 1,
    Snapshots: [{ DockerVersion: "24.0.0", TotalCPU: 4, Containers: [] }],
    TagIds: [],
    Kubernetes: {},
  };

  it("keeps the summary fields and drops Snapshots", () => {
    const e = compactEndpoint(fixture) as Record<string, unknown>;
    assert.equal(e.Id, 2);
    assert.equal(e.Name, "local");
    assert.equal(e.Type, 1);
    assert.equal(e.URL, "unix:///var/run/docker.sock");
    assert.equal(e.Status, 1);
    assert.equal(e.GroupId, 1);
    assert.equal("Snapshots" in e, false);
    assert.equal("TagIds" in e, false);
    assert.equal("Kubernetes" in e, false);
  });

  it("passes non-object items through untouched", () => {
    assert.equal(compactEndpoint(null), null);
    assert.equal(compactEndpoint("weird"), "weird");
  });
});
