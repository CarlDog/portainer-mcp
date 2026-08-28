import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneNoopWarning, withPruneWarning } from "../src/portainer.js";

describe("pruneNoopWarning", () => {
  it("returns null when prune wasn't requested, regardless of stack type", () => {
    assert.equal(pruneNoopWarning(1, false), null);
    assert.equal(pruneNoopWarning(2, false), null);
  });

  it("returns null for a Swarm stack (Type 1) even when prune was requested -- it actually works there", () => {
    assert.equal(pruneNoopWarning(1, true), null);
  });

  it("returns a warning for a Compose stack (Type 2) with prune requested", () => {
    const warning = pruneNoopWarning(2, true);
    assert.notEqual(warning, null);
    assert.match(warning as string, /no effect/);
    assert.match(warning as string, /Swarm/);
  });

  it("mentions the manual cleanup path so the warning is actionable", () => {
    const warning = pruneNoopWarning(2, true) as string;
    assert.match(warning, /portainer_list_containers/);
    assert.match(warning, /portainer_container_delete/);
  });
});

describe("withPruneWarning", () => {
  it("returns the result unchanged when warning is null", () => {
    const result = { Id: 1 };
    assert.equal(withPruneWarning(result, null), result);
  });

  it("merges pruneWarning onto an object result", () => {
    const result = withPruneWarning({ Id: 1 }, "prune has no effect here");
    assert.deepEqual(result, {
      Id: 1,
      pruneWarning: "prune has no effect here",
    });
  });

  it("wraps a non-object result rather than dropping the warning", () => {
    const result = withPruneWarning("ok", "prune has no effect here");
    assert.deepEqual(result, {
      result: "ok",
      pruneWarning: "prune has no effect here",
    });
  });
});
