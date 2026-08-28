import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { imagePruneQuery, withImagePrune } from "../src/portainer.js";

describe("imagePruneQuery", () => {
  it("defaults to dangling-only — the safe branch", () => {
    assert.deepEqual(imagePruneQuery({}), {
      filters: JSON.stringify({ dangling: ["true"] }),
    });
  });

  it("allUnused=false is the same safe dangling-only filter", () => {
    assert.deepEqual(imagePruneQuery({ allUnused: false }), {
      filters: JSON.stringify({ dangling: ["true"] }),
    });
  });

  it("allUnused=true switches to the aggressive dangling=false filter", () => {
    assert.deepEqual(imagePruneQuery({ allUnused: true }), {
      filters: JSON.stringify({ dangling: ["false"] }),
    });
  });
});

describe("withImagePrune", () => {
  it("merges imagePrune onto an object result", () => {
    const merged = withImagePrune(
      { Id: 42, Name: "my-stack" },
      { ImagesDeleted: null, SpaceReclaimed: 0 },
    ) as Record<string, unknown>;
    assert.equal(merged.Id, 42);
    assert.equal(merged.Name, "my-stack");
    assert.deepEqual(merged.imagePrune, {
      ImagesDeleted: null,
      SpaceReclaimed: 0,
    });
  });

  it("overwrites a pre-existing result field literally named imagePrune with the fresh prune result", () => {
    const merged = withImagePrune(
      { imagePrune: "original" },
      { SpaceReclaimed: 123 },
    ) as Record<string, unknown>;
    assert.deepEqual(merged.imagePrune, { SpaceReclaimed: 123 });
  });

  it("wraps a non-object result instead of dropping it", () => {
    assert.deepEqual(withImagePrune("raw text", { SpaceReclaimed: 0 }), {
      result: "raw text",
      imagePrune: { SpaceReclaimed: 0 },
    });
    assert.deepEqual(withImagePrune(null, { SpaceReclaimed: 0 }), {
      result: null,
      imagePrune: { SpaceReclaimed: 0 },
    });
  });

  it("wraps an array result instead of spreading it as an object", () => {
    assert.deepEqual(withImagePrune([1, 2, 3], { SpaceReclaimed: 0 }), {
      result: [1, 2, 3],
      imagePrune: { SpaceReclaimed: 0 },
    });
  });
});
