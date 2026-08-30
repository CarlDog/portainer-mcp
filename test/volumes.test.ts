import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertVolumeDeletionSafe } from "../src/portainer.js";

describe("assertVolumeDeletionSafe", () => {
  it("accepts only an exact inspected volume present in the dangling list", () => {
    assert.doesNotThrow(() =>
      assertVolumeDeletionSafe(
        "project_data",
        "project_data",
        { Name: "project_data" },
        { Volumes: [{ Name: "project_data" }] },
      ),
    );
  });

  it("rejects a second-factor name mismatch", () => {
    assert.throws(
      () =>
        assertVolumeDeletionSafe(
          "project_data",
          "project_cache",
          { Name: "project_data" },
          { Volumes: [{ Name: "project_data" }] },
        ),
      /Name mismatch/,
    );
  });

  it("rejects an inspected name that differs from the requested identifier", () => {
    assert.throws(
      () =>
        assertVolumeDeletionSafe(
          "project_data",
          "project_data",
          { Name: "other_data" },
          { Volumes: [{ Name: "other_data" }] },
        ),
      /resolved to/,
    );
  });

  it("rejects in-use volumes and substring-only filter matches", () => {
    assert.throws(
      () =>
        assertVolumeDeletionSafe(
          "project_data",
          "project_data",
          { Name: "project_data" },
          { Volumes: [{ Name: "project_data_backup" }] },
        ),
      /not currently dangling/,
    );
    assert.throws(
      () =>
        assertVolumeDeletionSafe(
          "project_data",
          "project_data",
          { Name: "project_data" },
          { Volumes: [] },
        ),
      /not currently dangling/,
    );
  });

  it("fails closed on malformed Portainer responses", () => {
    assert.throws(
      () =>
        assertVolumeDeletionSafe("project_data", "project_data", null, {
          Volumes: [],
        }),
      /malformed volume inspection/,
    );
    assert.throws(
      () =>
        assertVolumeDeletionSafe(
          "project_data",
          "project_data",
          { Name: "project_data" },
          { Volumes: null },
        ),
      /malformed dangling-volume list/,
    );
  });
});
