import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnreferencedEnvKeys, withEnvWarnings } from "../src/portainer.js";

describe("findUnreferencedEnvKeys", () => {
  it("returns nothing for a key referenced as ${KEY}", () => {
    assert.deepEqual(
      findUnreferencedEnvKeys("environment:\n  - FOO=${FOO}\n", ["FOO"]),
      [],
    );
  });

  it("returns nothing for a key referenced as ${KEY:-default}", () => {
    assert.deepEqual(
      findUnreferencedEnvKeys("image: app:${TAG:-latest}\n", ["TAG"]),
      [],
    );
  });

  it("returns nothing for a key referenced as ${KEY:?required}", () => {
    assert.deepEqual(
      findUnreferencedEnvKeys("x: ${API_KEY:?must be set}\n", ["API_KEY"]),
      [],
    );
  });

  it("returns nothing for a bare $KEY reference", () => {
    assert.deepEqual(findUnreferencedEnvKeys("cmd: echo $FOO\n", ["FOO"]), []);
  });

  it("flags a key with no reference at all", () => {
    assert.deepEqual(findUnreferencedEnvKeys("image: app:latest\n", ["FOO"]), [
      "FOO",
    ]);
  });

  it("does not false-positive on a bare $KEY that's actually a longer name", () => {
    // $FOO_BAR must not satisfy a search for FOO.
    assert.deepEqual(findUnreferencedEnvKeys("cmd: echo $FOO_BAR\n", ["FOO"]), [
      "FOO",
    ]);
  });

  it("does not false-positive on ${KEY_EXTRA} when searching for KEY", () => {
    assert.deepEqual(findUnreferencedEnvKeys("x: ${KEY_EXTRA}\n", ["KEY"]), [
      "KEY",
    ]);
  });

  it("handles multiple keys independently", () => {
    const compose = "environment:\n  - A=${A}\n  - C=$C\n";
    assert.deepEqual(findUnreferencedEnvKeys(compose, ["A", "B", "C"]), ["B"]);
  });

  it("returns [] for an empty keys list", () => {
    assert.deepEqual(findUnreferencedEnvKeys("anything", []), []);
  });

  it("escapes regex-special characters in key names safely", () => {
    // A key containing regex metacharacters must not throw or match wrongly.
    assert.deepEqual(
      findUnreferencedEnvKeys("x: ${FOO.BAR}\n", ["FOO.BAR"]),
      [],
    );
    assert.deepEqual(findUnreferencedEnvKeys("no refs here\n", ["A+B"]), [
      "A+B",
    ]);
  });
});

describe("withEnvWarnings", () => {
  it("returns the result unchanged when warnings is empty", () => {
    const result = { Id: 1 };
    assert.equal(withEnvWarnings(result, []), result);
  });

  it("merges envWarnings onto an object result", () => {
    const result = withEnvWarnings({ Id: 1 }, ["FOO unreferenced"]);
    assert.deepEqual(result, { Id: 1, envWarnings: ["FOO unreferenced"] });
  });

  it("wraps a non-object result rather than dropping the warnings", () => {
    const result = withEnvWarnings("ok", ["FOO unreferenced"]);
    assert.deepEqual(result, {
      result: "ok",
      envWarnings: ["FOO unreferenced"],
    });
  });
});
