import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../src/portainer.js";

const REDACTED = "<redacted>";

/** Wrap a Portainer-style object-form Env array and run the redactor. */
function scrubObjectEnv(name: string, value: string): unknown {
  const out = redactSecrets({ Env: [{ Name: name, Value: value }] }) as {
    Env: Array<{ Name: string; Value: string }>;
  };
  return out.Env[0]?.Value;
}

/** Wrap a Docker-inspect-style "KEY=VALUE" Env array and run the redactor. */
function scrubStringEnv(entry: string): unknown {
  const out = redactSecrets({ Env: [entry] }) as { Env: string[] };
  return out.Env[0];
}

describe("redactSecrets — key-name matching", () => {
  const secretKeys = [
    "DB_PASSWORD",
    "PASSWD",
    "MY_SECRET",
    "AUTH_TOKEN",
    "API_KEY",
    "api-key",
    "ACCESS_KEY",
    "SIGNING_KEY",
    "SESSION_JWT",
    "BEARER",
    "GIT_CREDENTIAL",
    "SENTRY_DSN",
    "DATABASE_URL",
    "MONGO_URI",
    "PG_CONN",
    "ADMIN_PW",
    "DB_PWD",
  ];
  for (const key of secretKeys) {
    it(`redacts by key name: ${key}`, () => {
      assert.equal(scrubObjectEnv(key, "plain-value"), REDACTED);
      assert.equal(scrubStringEnv(`${key}=plain-value`), `${key}=${REDACTED}`);
    });
  }

  const benignKeys = ["TZ", "PUID", "LOG_LEVEL", "HOSTNAME", "UMASK"];
  for (const key of benignKeys) {
    it(`passes through benign key: ${key}`, () => {
      assert.equal(scrubObjectEnv(key, "some-value"), "some-value");
      assert.equal(scrubStringEnv(`${key}=some-value`), `${key}=some-value`);
    });
  }
});

describe("redactSecrets — value-shape matching (benign key names)", () => {
  const secretValues: Array<[string, string]> = [
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZ25hdHVyZQ"],
    ["GitHub PAT (ghp_)", "ghp_" + "A".repeat(36)],
    ["GitHub fine-grained PAT", "github_pat_" + "A".repeat(24)],
    ["Stripe live secret", "sk_live_" + "a".repeat(24)],
    ["Stripe test publishable", "pk_test_" + "a".repeat(24)],
    ["Anthropic key", "sk-ant-" + "a".repeat(24)],
    ["OpenAI key", "sk-" + "a".repeat(24)],
    ["Slack bot token", "xoxb-" + "1".repeat(24)],
    ["AWS access key", "AKIA" + "A".repeat(16)],
    ["Google API key", "AIza" + "A".repeat(35)],
    ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nabc"],
    [
      "URL with inline creds",
      "postgres://user:s3cr3tpass@db.internal:5432/app",
    ],
    ["redis URL with creds", "redis://default:longpassword123@cache:6379/0"],
  ];
  for (const [label, value] of secretValues) {
    it(`redacts by value shape: ${label}`, () => {
      assert.equal(scrubObjectEnv("SESSION_DATA", value), REDACTED);
      assert.equal(
        scrubStringEnv(`SESSION_DATA=${value}`),
        `SESSION_DATA=${REDACTED}`,
      );
    });
  }

  const benignValues: Array<[string, string]> = [
    ["UUID", "0d1f6a2e-9b3c-4d5e-8f7a-1b2c3d4e5f6a"],
    ["container ID", "a".repeat(64)],
    ["plain URL, no creds", "https://registry.example.com/v2/library/nginx"],
    ["URL with port only", "http://portainer:9000/api"],
  ];
  for (const [label, value] of benignValues) {
    it(`passes through benign value: ${label}`, () => {
      assert.equal(scrubObjectEnv("SESSION_DATA", value), value);
    });
  }
});

describe("redactSecrets — env-array shapes and casing", () => {
  it("handles lowercase env key and lowercase name/value fields", () => {
    const out = redactSecrets({
      env: [{ name: "DB_PASSWORD", value: "hunter2" }],
    }) as { env: Array<{ name: string; value: string }> };
    assert.equal(out.env[0]?.value, REDACTED);
    assert.equal(out.env[0]?.name, "DB_PASSWORD");
  });

  it("scrubs Env arrays nested deep in the response", () => {
    const out = redactSecrets({
      Config: { Env: ["API_KEY=abc123", "TZ=UTC"] },
    }) as { Config: { Env: string[] } };
    assert.deepEqual(out.Config.Env, [`API_KEY=${REDACTED}`, "TZ=UTC"]);
  });

  it("leaves entries without '=' untouched in string form", () => {
    const out = redactSecrets({ Env: ["JUSTAFLAG"] }) as { Env: string[] };
    assert.deepEqual(out.Env, ["JUSTAFLAG"]);
  });

  it("preserves value containing '=' after the first separator", () => {
    assert.equal(scrubStringEnv("TZ=Etc/GMT+5=weird"), "TZ=Etc/GMT+5=weird");
    assert.equal(scrubStringEnv("TOKEN=abc=def"), `TOKEN=${REDACTED}`);
  });

  it("does not throw on null / primitives / non-array Env", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(42), 42);
    assert.deepEqual(redactSecrets({ Env: "not-an-array" }), {
      Env: "not-an-array",
    });
  });
});
