import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imagePruneQuery } from "../src/portainer.js";

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

describe("image prune policy", () => {
  it("keeps pruning explicit instead of hiding it in redeploy/recreate", () => {
    const source = readFileSync(
      new URL("../src/portainer.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /pruneDanglingAfterRedeploy|withImagePrune/);
  });
});
