import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareEnvValuesResult } from "../src/portainer.js";

describe("compareEnvValuesResult", () => {
  it("matches two equal, non-empty values", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "same-secret" },
      { found: true, value: "same-secret" },
    );
    assert.equal(result.match, true);
    assert.deepEqual(result.a, { found: true, empty: false });
    assert.deepEqual(result.b, { found: true, empty: false });
  });

  it("does not match two different non-empty values", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "secret-a" },
      { found: true, value: "secret-b" },
    );
    assert.equal(result.match, false);
  });

  it("does not match when one side is missing entirely", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "secret" },
      { found: false, value: "" },
    );
    assert.equal(result.match, false);
    assert.deepEqual(result.a, { found: true, empty: false });
    assert.deepEqual(result.b, { found: false, empty: false });
  });

  it("does not match when one side is present but empty", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "secret" },
      { found: true, value: "" },
    );
    assert.equal(result.match, false);
    assert.deepEqual(result.b, { found: true, empty: true });
  });

  it("two empty values on both sides are still not a match", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "" },
      { found: true, value: "" },
    );
    assert.equal(result.match, false);
    assert.deepEqual(result.a, { found: true, empty: true });
    assert.deepEqual(result.b, { found: true, empty: true });
  });

  it("two missing values on both sides are still not a match", () => {
    const result = compareEnvValuesResult(
      { found: false, value: "" },
      { found: false, value: "" },
    );
    assert.equal(result.match, false);
    assert.deepEqual(result.a, { found: false, empty: false });
    assert.deepEqual(result.b, { found: false, empty: false });
  });

  it("is case- and byte-sensitive — a single differing character never matches", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "Token123" },
      { found: true, value: "token123" },
    );
    assert.equal(result.match, false);
  });

  it("never leaks the compared values on the result object", () => {
    const result = compareEnvValuesResult(
      { found: true, value: "top-secret-value" },
      { found: true, value: "top-secret-value" },
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("top-secret-value"), false);
  });
});
