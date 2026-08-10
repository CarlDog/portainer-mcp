import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Guards the one transport rule that caused a real outage: the Portainer
// client must issue requests through undici's own request(), never through
// global fetch.
//
// Node's global fetch is served by the undici copy bundled inside Node. An
// Agent constructed from the installed undici package belongs to a different
// module instance, so global fetch may silently ignore the `dispatcher`
// option — dropping `connect.rejectUnauthorized: false` and breaking every
// call to a self-signed Portainer with a bare "fetch failed". Whether it is
// honored has changed between Node majors; the node:22-alpine ->
// node:26-alpine bump is what tripped it in production.
//
// This is a source-level assertion on purpose: reproducing the failure needs
// a self-signed TLS server on a specific Node major, which is far more
// machinery than the rule warrants. The rule is simply "don't call fetch here."
const source = readFileSync(
  fileURLToPath(new URL("../src/portainer.ts", import.meta.url)),
  "utf8",
);

// Strip comments so the prose above (and the explainer in portainer.ts)
// can mention fetch without tripping the assertion.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("portainer client transport", () => {
  test("does not call global fetch", () => {
    assert.doesNotMatch(
      code,
      /(?<![.\w])fetch\s*\(/,
      "src/portainer.ts must not call global fetch — it ignores the undici " +
        "Agent dispatcher, which disables the PORTAINER_VERIFY_TLS=false " +
        "escape hatch. Use undici's request() instead.",
    );
  });

  test("routes requests through undici's request()", () => {
    assert.match(
      code,
      /undiciRequest\s*\(/,
      "src/portainer.ts should issue requests via undici's request() so the " +
        "insecure Agent dispatcher is honored.",
    );
  });

  test("still builds the insecure dispatcher when TLS verification is off", () => {
    assert.match(code, /rejectUnauthorized:\s*false/);
  });
});
