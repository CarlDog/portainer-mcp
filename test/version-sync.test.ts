// REQUIRED ENFORCEMENT TEST — fleet standard MCP-T03.
//
// SERVER_VERSION (src/shared/version.ts) must equal package.json's version.
// These were previously two hand-maintained literals, and they had already
// drifted: package.json read 0.6.0 while src/index.ts hardcoded "0.1.0", so
// the MCP initialize response reported 0.1.0 to every client. Bump one
// without the other now and the suite goes red in the same commit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SERVER_VERSION } from "../src/shared/version.js";

describe("version sync", () => {
  it("SERVER_VERSION matches package.json", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(SERVER_VERSION, pkg.version);
  });

  it("SERVER_VERSION is valid semver", () => {
    // Catches a half-finished bump such as "0.2" or a leftover placeholder.
    assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });
});
