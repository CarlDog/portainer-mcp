// Single source of truth for the server's reported version. Keep this in
// lockstep with package.json's "version" field — test/version-sync.test.ts
// enforces it, so bumping one without the other fails the suite in the same
// commit instead of shipping a stale version in the MCP initialize response.
//
// This file exists because that exact drift happened here: package.json read
// 0.6.0 while src/index.ts hardcoded "0.1.0", so every client was told 0.1.0
// for five minor versions. A comment asking the next person to keep two
// literals in step has no failure mode; this does (fleet standard MCP-T03).
export const SERVER_VERSION = "0.8.0";
