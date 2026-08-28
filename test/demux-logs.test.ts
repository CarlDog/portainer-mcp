import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demuxDockerLogs, parseDockerTimeFilter } from "../src/portainer.js";

// Builds one Docker log stream frame: 1-byte stream type + 3 zero bytes +
// 4-byte big-endian payload length, followed by the payload itself.
function frame(streamType: number, payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

describe("demuxDockerLogs", () => {
  it("strips a single stdout frame's header", () => {
    const buf = frame(1, "2026-01-01T00:00:00Z hello world\n");
    assert.equal(demuxDockerLogs(buf), "2026-01-01T00:00:00Z hello world\n");
  });

  it("concatenates multiple stdout/stderr frames in order", () => {
    const buf = Buffer.concat([
      frame(1, "line one\n"),
      frame(2, "an error\n"),
      frame(1, "line two\n"),
    ]);
    assert.equal(demuxDockerLogs(buf), "line one\nan error\nline two\n");
  });

  it("returns empty string for an empty buffer", () => {
    assert.equal(demuxDockerLogs(Buffer.alloc(0)), "");
  });

  it("correctly demuxes a payload >= 128 bytes, where the length field itself contains a byte >= 0x80", () => {
    // This is the actual trap: demuxing against an already-UTF-8-decoded
    // string (instead of raw bytes) would have mangled this exact byte
    // into U+FFFD before the demuxer ever saw it, since 0x80 alone is an
    // invalid UTF-8 continuation byte. Operating on the raw Buffer must
    // read the length correctly and extract the payload untouched.
    const longLine = "x".repeat(150) + "\n";
    const buf = frame(1, longLine);
    // Sanity-check the trap is actually present in this fixture.
    assert.equal(buf.readUInt8(7) >= 0x80, true);
    assert.equal(demuxDockerLogs(buf), longLine);
  });

  it("falls back to raw text for an unframed (TTY) stream", () => {
    // Stream type 3 is invalid (only 0/1/2 are defined), so this can
    // never be mistaken for a valid frame -- immediate fallback.
    const ttyOutput = "\x1b[32mall good\x1b[0m\n";
    const buf = Buffer.from(ttyOutput, "utf8");
    assert.equal(demuxDockerLogs(buf), ttyOutput);
  });

  it("falls back to raw text when a declared frame length overruns the buffer", () => {
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(9999, 4); // declares far more payload than exists
    const buf = Buffer.concat([header, Buffer.from("short", "utf8")]);
    assert.equal(demuxDockerLogs(buf), buf.toString("utf8"));
  });

  it("falls back to raw text when fewer than 8 bytes remain for a header", () => {
    const buf = Buffer.from([1, 0, 0]);
    assert.equal(demuxDockerLogs(buf), buf.toString("utf8"));
  });

  it("handles a zero-length payload frame", () => {
    const buf = Buffer.concat([frame(1, ""), frame(1, "next\n")]);
    assert.equal(demuxDockerLogs(buf), "next\n");
  });
});

describe("parseDockerTimeFilter", () => {
  const NOW = Date.parse("2026-08-28T20:40:00Z");

  it("treats a bare digit string as an absolute Unix timestamp", () => {
    assert.equal(parseDockerTimeFilter("1725000000", NOW), 1725000000);
  });

  it("parses an RFC3339 datetime to Unix seconds", () => {
    assert.equal(
      parseDockerTimeFilter("2026-08-28T20:00:00Z", NOW),
      Date.parse("2026-08-28T20:00:00Z") / 1000,
    );
  });

  it("parses a minutes-only relative duration counted back from now", () => {
    assert.equal(parseDockerTimeFilter("10m", NOW), NOW / 1000 - 10 * 60);
  });

  it("parses a combined hours+minutes relative duration", () => {
    assert.equal(
      parseDockerTimeFilter("1h30m", NOW),
      NOW / 1000 - (1 * 3600 + 30 * 60),
    );
  });

  it("parses a seconds-only relative duration", () => {
    assert.equal(parseDockerTimeFilter("45s", NOW), NOW / 1000 - 45);
  });

  it("parses a combined days+hours+minutes+seconds relative duration", () => {
    assert.equal(
      parseDockerTimeFilter("1d2h3m4s", NOW),
      NOW / 1000 - (1 * 86400 + 2 * 3600 + 3 * 60 + 4),
    );
  });

  it("defaults `now` to the real clock when omitted", () => {
    const before = Date.now();
    const result = parseDockerTimeFilter("10m");
    const after = Date.now();
    assert.equal(result >= Math.floor(before / 1000) - 600, true);
    assert.equal(result <= Math.floor(after / 1000) - 600, true);
  });

  it("throws on an empty string rather than silently matching zero duration", () => {
    assert.throws(() => parseDockerTimeFilter("", NOW), /Invalid time filter/);
  });

  it("throws on nonsense input", () => {
    assert.throws(
      () => parseDockerTimeFilter("banana", NOW),
      /Invalid time filter "banana"/,
    );
  });

  it("throws on a duration with units out of order", () => {
    assert.throws(
      () => parseDockerTimeFilter("30m1h", NOW),
      /Invalid time filter/,
    );
  });
});
