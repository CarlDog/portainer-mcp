import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAllowedHosts,
  parseBindHost,
  parseLogLevel,
  parseOptionalPort,
  parsePositiveInteger,
  requestAuthorityAllowed,
} from "../src/shared/mcp-environment.js";

test("normalizes DNS, IPv4, bracketed IPv6, and duplicates", () => {
  assert.deepEqual(
    parseAllowedHosts(" Example.TEST. ,127.0.0.1,[::1],example.test"),
    ["example.test", "127.0.0.1", "::1"],
  );
});

test("defaults the HTTP allowlist to fleet and loopback hosts", () => {
  const fleetHosts = ["localhost", "127.0.0.1", "::1", "host.docker.internal"];
  assert.deepEqual(parseAllowedHosts(undefined), fleetHosts);
  assert.deepEqual(parseAllowedHosts("  "), fleetHosts);
});

test("rejects authority syntax, wildcards, paths, and empty entries", () => {
  for (const value of [
    "example.test:443",
    "https://example.test",
    "*.example.test",
    "example.test/path",
    "example.test,,localhost",
  ]) {
    assert.throws(() => parseAllowedHosts(value), /MCP_ALLOWED_HOSTS/);
  }
});

test("parses bounded integers without accepting junk suffixes", () => {
  assert.equal(parseOptionalPort("65535"), 65_535);
  assert.equal(parseOptionalPort(undefined), undefined);
  assert.equal(
    parsePositiveInteger("MCP_SESSION_IDLE_MS", undefined, 123),
    123,
  );
  for (const value of ["0", "-1", "+1", "3000junk", "65536"]) {
    assert.throws(() => parseOptionalPort(value), /MCP_PORT/);
  }
});

test("validates bind hosts and log levels", () => {
  assert.equal(parseBindHost(undefined), "127.0.0.1");
  assert.equal(parseBindHost("0.0.0.0"), "0.0.0.0");
  assert.equal(parseBindHost("::"), "::");
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(" WARN "), "warn");
  for (const value of ["https://localhost", "localhost:3000", "[::1]"]) {
    assert.throws(() => parseBindHost(value), /MCP_BIND_HOST/);
  }
  assert.throws(() => parseLogLevel("verbose"), /LOG_LEVEL/);
});

test("requires Host and present Origin to pass independently", () => {
  const allowed = parseAllowedHosts("example.test,localhost");
  assert.equal(
    requestAuthorityAllowed({ host: "Example.Test:3000" }, allowed),
    true,
  );
  assert.equal(
    requestAuthorityAllowed(
      { host: "example.test:3000", origin: "https://example.test:8443" },
      allowed,
    ),
    true,
  );
  assert.equal(
    requestAuthorityAllowed(
      { host: "evil.test", origin: "https://example.test" },
      allowed,
    ),
    false,
  );
  assert.equal(
    requestAuthorityAllowed(
      { host: "example.test", origin: "https://evil.test" },
      allowed,
    ),
    false,
  );
  assert.equal(
    requestAuthorityAllowed({ origin: "https://example.test" }, allowed),
    false,
  );
});

test("accepts valid IPv4 and bracketed IPv6 Host authorities", () => {
  assert.equal(
    requestAuthorityAllowed(
      { host: "127.0.0.1:3000" },
      parseAllowedHosts("127.0.0.1"),
    ),
    true,
  );
  assert.equal(
    requestAuthorityAllowed(
      { host: "[::1]:3000", origin: "http://[::1]:3000" },
      parseAllowedHosts("[::1]"),
    ),
    true,
  );
});
