import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diffContainerRecreation,
  withContainerChanges,
} from "../src/portainer.js";

describe("diffContainerRecreation", () => {
  it("marks a container recreated when its id changed under the same name", () => {
    const before = [{ name: "/app-1", id: "aaa" }];
    const after = [{ name: "/app-1", id: "bbb" }];
    assert.deepEqual(diffContainerRecreation(before, after), [
      { name: "/app-1", status: "recreated" },
    ]);
  });

  it("marks a container unchanged when its id is identical -- the silent-no-op case", () => {
    const before = [{ name: "/app-1", id: "aaa" }];
    const after = [{ name: "/app-1", id: "aaa" }];
    assert.deepEqual(diffContainerRecreation(before, after), [
      { name: "/app-1", status: "unchanged" },
    ]);
  });

  it("marks a container removed when it's gone after", () => {
    const before = [{ name: "/app-1", id: "aaa" }];
    const after: typeof before = [];
    assert.deepEqual(diffContainerRecreation(before, after), [
      { name: "/app-1", status: "removed" },
    ]);
  });

  it("marks a container added when it's new after", () => {
    const before: Array<{ name: string; id: string }> = [];
    const after = [{ name: "/app-1", id: "aaa" }];
    assert.deepEqual(diffContainerRecreation(before, after), [
      { name: "/app-1", status: "added" },
    ]);
  });

  it("handles a multi-service stack with mixed outcomes, sorted by name", () => {
    const before = [
      { name: "/z-service", id: "z1" },
      { name: "/a-service", id: "a1" },
      { name: "/gone-service", id: "g1" },
    ];
    const after = [
      { name: "/z-service", id: "z2" },
      { name: "/a-service", id: "a1" },
      { name: "/new-service", id: "n1" },
    ];
    assert.deepEqual(diffContainerRecreation(before, after), [
      { name: "/a-service", status: "unchanged" },
      { name: "/gone-service", status: "removed" },
      { name: "/new-service", status: "added" },
      { name: "/z-service", status: "recreated" },
    ]);
  });

  it("returns an empty array for two empty snapshots", () => {
    assert.deepEqual(diffContainerRecreation([], []), []);
  });
});

describe("withContainerChanges", () => {
  it("merges containerChanges onto an object result", () => {
    const result = withContainerChanges(
      { Id: 1 },
      [{ name: "/app-1", id: "aaa" }],
      [{ name: "/app-1", id: "bbb" }],
    );
    assert.deepEqual(result, {
      Id: 1,
      containerChanges: [{ name: "/app-1", status: "recreated" }],
    });
  });

  it("wraps a non-object result rather than dropping the diff", () => {
    const result = withContainerChanges(
      "ok",
      [{ name: "/app-1", id: "aaa" }],
      [{ name: "/app-1", id: "aaa" }],
    );
    assert.deepEqual(result, {
      result: "ok",
      containerChanges: [{ name: "/app-1", status: "unchanged" }],
    });
  });

  it("omits the field entirely when the before snapshot is null (read failed)", () => {
    const result = withContainerChanges({ Id: 1 }, null, [
      { name: "/app-1", id: "aaa" },
    ]);
    assert.deepEqual(result, { Id: 1 });
  });

  it("omits the field entirely when the after snapshot is null (read failed)", () => {
    const result = withContainerChanges({ Id: 1 }, [], null);
    assert.deepEqual(result, { Id: 1 });
  });

  it("does not misreport a null-before/empty-after read failure as all-added", () => {
    // A genuinely empty snapshot ([]) is a real, meaningful state (e.g. a
    // stack whose only service is profile-gated and never started) -- it
    // must never be silently substituted for a failed read (null).
    const result = withContainerChanges({ Id: 1 }, null, []);
    assert.deepEqual(result, { Id: 1 });
  });
});
