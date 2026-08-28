import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import { z } from "zod";
import { asText } from "./util.js";
import { registerSystemTools } from "./tools/system.js";

export interface PortainerConfig {
  url: string;
  apiKey: string;
  verifyTls: boolean;
}

interface PortainerRequestInit {
  method: Dispatcher.HttpMethod;
  headers: Record<string, string>;
  body?: string;
  dispatcher?: Agent;
}

// Key-name patterns. If a stack env entry's NAME matches this, the
// VALUE is redacted regardless of its content. Conservative-but-broader
// than the original — added: jwt, bearer, credential, dsn, url/uri/conn
// (connection strings like DATABASE_URL / MONGO_URI / PG_CONN often
// inline creds), pw/pwd (ADMIN_PW-style abbreviations).
const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$|jwt|bearer|credential|dsn|url|uri|conn|pwd?$)/i;

// Value-shape patterns. If a stack env entry's VALUE matches any of
// these, the value is redacted regardless of the key name. Catches the
// classic "key name doesn't telegraph 'this is a secret' but the value
// definitely is one" case (e.g. BOTIFY_JWT — name doesn't match the
// key regex, but the value is unmistakably a JWT). Each pattern is
// chosen for near-zero false positives — they all anchor on issuer
// prefixes or wire shapes that don't appear in non-secret values.
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // JWT — three dot-separated base64url segments, standard header
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  // GitHub Personal Access Tokens (ghp_, gho_, ghs_, ghr_, ghu_)
  /^gh[pousr]_[A-Za-z0-9]{36,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  // Stripe live/test secret + publishable
  /^(sk|pk)_(live|test)_[A-Za-z0-9]{20,}$/,
  // Anthropic / OpenAI (sk- and sk-ant-)
  /^sk-(ant-)?[A-Za-z0-9_-]{20,}$/,
  // Slack tokens (xoxb, xoxp, xoxa, xoxr, xoxs)
  /^xox[baprs]-[A-Za-z0-9-]{20,}$/,
  // AWS access key IDs
  /^(AKIA|ASIA)[A-Z0-9]{16}$/,
  // Google API keys
  /^AIza[A-Za-z0-9_-]{35}$/,
  // PEM-encoded private keys (any line containing the marker)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // URL with inline credentials: scheme://user:pass@host — the
  // user:pass@ segment before the host is unmistakably a credential
  /:\/\/[^/\s@:]+:[^/\s@]+@/,
];

const REDACTED = "<redacted>";

function looksLikeSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 20) return false;
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

function scrubEnvArray(arr: unknown[]): unknown[] {
  return arr.map((entry) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const nameKey = "Name" in e ? "Name" : "name" in e ? "name" : null;
      const valueKey = "Value" in e ? "Value" : "value" in e ? "value" : null;
      if (nameKey && valueKey && typeof e[nameKey] === "string") {
        const matchesName = SECRET_KEY_RE.test(e[nameKey] as string);
        const matchesValue = looksLikeSecretValue(e[valueKey]);
        if (matchesName || matchesValue) {
          return { ...e, [valueKey]: REDACTED };
        }
      }
      return entry;
    }
    if (typeof entry === "string") {
      const eq = entry.indexOf("=");
      if (eq > 0) {
        const key = entry.slice(0, eq);
        const value = entry.slice(eq + 1);
        if (SECRET_KEY_RE.test(key) || looksLikeSecretValue(value)) {
          return `${key}=${REDACTED}`;
        }
      }
    }
    return entry;
  });
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactSecrets(value[i]);
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === "env" && Array.isArray(v)) {
        obj[k] = scrubEnvArray(v);
      } else if (
        k.toLowerCase() === "webhook" &&
        typeof v === "string" &&
        v.length > 0
      ) {
        // A stack's Webhook is a UUID that triggers an unauthenticated
        // public redeploy (POST /stacks/webhooks/{id}) — a bearer token,
        // not a display value. Empty string (no webhook configured) isn't
        // secret and passes through unchanged.
        obj[k] = REDACTED;
      } else {
        obj[k] = redactSecrets(v);
      }
    }
    return obj;
  }
  return value;
}

export interface ContainerListOptions {
  all?: boolean;
  name?: string;
  label?: string;
  status?: string;
}

// Builds the query for GET /containers/json. Filters use Docker's
// JSON map-of-arrays encoding. A status filter implies all=true: Docker
// only inspects the containers the `all` window admits, so status=exited
// against the default running-only window silently returns [] — the
// "ignored filter looks fine" trap.
export function containerListQuery(
  opts: ContainerListOptions,
): Record<string, string> {
  const filters: Record<string, string[]> = {};
  if (opts.name) filters.name = [opts.name];
  if (opts.label) filters.label = [opts.label];
  if (opts.status) filters.status = [opts.status];
  const query: Record<string, string> = {};
  if (opts.all || opts.status) query.all = "true";
  if (Object.keys(filters).length > 0) query.filters = JSON.stringify(filters);
  return query;
}

// Compact projection for list output: full Docker list JSON runs to ~2 KB
// per container (HostConfig, NetworkSettings, Mounts…), which eats the
// caller's context window fleet-wide. Keeps what an operator scans for,
// plus the compose project label that maps stack → containers.
export function compactContainer(c: unknown): unknown {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return c;
  const o = c as Record<string, unknown>;
  const labels = (o.Labels ?? {}) as Record<string, unknown>;
  const ports = Array.isArray(o.Ports)
    ? [
        ...new Set(
          (o.Ports as Record<string, unknown>[]).map((p) =>
            p.PublicPort !== undefined
              ? `${String(p.IP ?? "")}:${String(p.PublicPort)}->${String(p.PrivatePort)}/${String(p.Type)}`
              : `${String(p.PrivatePort)}/${String(p.Type)}`,
          ),
        ),
      ]
    : [];
  const out: Record<string, unknown> = {
    Id: typeof o.Id === "string" ? o.Id.slice(0, 12) : o.Id,
    Names: o.Names,
    Image: o.Image,
    State: o.State,
    Status: o.Status,
    Created: o.Created,
    Ports: ports,
  };
  const project = labels["com.docker.compose.project"];
  if (project !== undefined) out.ComposeProject = project;
  return out;
}

// Portainer's stacks endpoint has no server-side name filter (its only
// documented filters are EndpointID/SwarmID — confirmed against the
// pinned Swagger spec), so this is a client-side substring filter over
// an already-fetched list, applied in the tool handler.
export function filterStacksByName(stacks: unknown[], name: string): unknown[] {
  const needle = name.toLowerCase();
  return stacks.filter((s) => {
    if (s === null || typeof s !== "object") return false;
    const n = (s as Record<string, unknown>).Name;
    return typeof n === "string" && n.toLowerCase().includes(needle);
  });
}

// Compact projection for list output: a Stack object carries Env
// (redacted array), GitConfig, Option, ResourceControl, and other detail
// no summary view needs — full detail already lives in portainer_get_stack.
// GitManaged is a derived boolean rather than echoing GitConfig itself,
// which is redundant at summary granularity.
export function compactStack(s: unknown): unknown {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return s;
  const o = s as Record<string, unknown>;
  return {
    Id: o.Id,
    Name: o.Name,
    Type: o.Type,
    EndpointId: o.EndpointId,
    Status: o.Status,
    CreationDate: o.CreationDate,
    GitManaged: o.GitConfig != null,
  };
}

// Compact projection for a single container's full Docker inspect JSON —
// that response runs ~2-4 KB (NetworkSettings internals, GraphDriver,
// HostnamePath/HostsPath/ResolvConfPath, ExecIDs, MountLabel,
// AppArmorProfile, …) for detail a caller inspecting ONE container rarely
// wants. Unlike compactContainer (a list-summary view), this keeps Env —
// inspecting a single container is exactly when its config matters, and
// redactSecrets already scrubs it regardless of nesting depth.
export function compactContainerInspect(c: unknown): unknown {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return c;
  const o = c as Record<string, unknown>;
  const config = (o.Config ?? {}) as Record<string, unknown>;
  const labels = (config.Labels ?? {}) as Record<string, unknown>;
  const networkSettings = (o.NetworkSettings ?? {}) as Record<string, unknown>;
  const mounts = Array.isArray(o.Mounts)
    ? (o.Mounts as Record<string, unknown>[]).map((m) => ({
        Source: m.Source,
        Destination: m.Destination,
        RW: m.RW,
      }))
    : [];
  const out: Record<string, unknown> = {
    Id: o.Id,
    Name: o.Name,
    Image: config.Image,
    State: o.State,
    Created: o.Created,
    RestartCount: o.RestartCount,
    Env: config.Env,
    Ports: networkSettings.Ports,
    Mounts: mounts,
  };
  const project = labels["com.docker.compose.project"];
  if (project !== undefined) out.ComposeProject = project;
  return out;
}

// Compact projection for endpoint list output: an Endpoint object's
// Snapshots array embeds a full Docker system snapshot (all containers,
// images, volumes at last sync) per endpoint — by far the largest field
// and rarely what a caller wants from a list. Full detail isn't available
// through any other current tool, so callers needing Snapshots use
// full: true.
export function compactEndpoint(e: unknown): unknown {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
  const o = e as Record<string, unknown>;
  return {
    Id: o.Id,
    Name: o.Name,
    Type: o.Type,
    URL: o.URL,
    Status: o.Status,
    GroupId: o.GroupId,
  };
}

export interface ImagePruneOptions {
  allUnused?: boolean;
}

// Builds the query for POST /images/prune. Docker's own filter semantics:
// dangling=true (the default, and what we send when allUnused is falsy)
// removes only untagged/dangling images — exactly the leftovers a
// rebuild-and-repush leaves behind once a tag moves to a new digest.
// dangling=false is the aggressive `-a` mode: it also removes tagged
// images that aren't backing any container right now, which can delete
// an image kept around for rollback. Default to the safe branch — never
// infer the aggressive one from omission.
export function imagePruneQuery(
  opts: ImagePruneOptions,
): Record<string, string> {
  const dangling = opts.allUnused ? "false" : "true";
  return { filters: JSON.stringify({ dangling: [dangling] }) };
}

// Merges an automatic post-redeploy image-prune result into a redeploy/
// recreate response without clobbering it. Portainer's redeploy/recreate
// endpoints return the updated Stack or Container object (a JSON object),
// so the common case spreads cleanly; the fallback branch exists only in
// case a response shape ever turns out not to be a plain object.
export function withImagePrune(result: unknown, imagePrune: unknown): unknown {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), imagePrune };
  }
  return { result, imagePrune };
}

export interface ContainerIdentity {
  name: string;
  id: string;
}

export interface ContainerChange {
  name: string;
  status: "recreated" | "unchanged" | "removed" | "added";
}

// Compares a stack's containers before/after a redeploy-shaped write to
// answer the question a redeploy "succeeding" doesn't: did anything
// actually change? A 200 response only means Portainer accepted the
// call — set_stack_env/redeploy_stack have both been caught silently
// no-op'ing on a live container while reporting success (e.g. a
// compose file that hardcodes a value instead of referencing ${VAR} --
// envWarnings catches that specific case, this catches the general
// one). Matched by container name (Docker's `Names[0]`, stable across
// a recreate); a changed Id under the same name means recreated, same
// Id means the write had no effect on that container.
export function diffContainerRecreation(
  before: ContainerIdentity[],
  after: ContainerIdentity[],
): ContainerChange[] {
  const beforeMap = new Map(before.map((c) => [c.name, c.id]));
  const afterMap = new Map(after.map((c) => [c.name, c.id]));
  const names = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changes: ContainerChange[] = [];
  for (const name of names) {
    const beforeId = beforeMap.get(name);
    const afterId = afterMap.get(name);
    if (beforeId === undefined) {
      changes.push({ name, status: "added" });
    } else if (afterId === undefined) {
      changes.push({ name, status: "removed" });
    } else if (beforeId !== afterId) {
      changes.push({ name, status: "recreated" });
    } else {
      changes.push({ name, status: "unchanged" });
    }
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

// Merges the container-recreation diff onto a redeploy-shaped response,
// same additive pattern as withImagePrune/withEnvWarnings. `null` for
// either snapshot means the pre/post container list couldn't be read
// (best-effort, never blocks the actual write) -- omit the field
// entirely rather than emit a diff that would misleadingly read every
// container as "added".
export function withContainerChanges(
  result: unknown,
  before: ContainerIdentity[] | null,
  after: ContainerIdentity[] | null,
): unknown {
  if (before === null || after === null) return result;
  const containerChanges = diffContainerRecreation(before, after);
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), containerChanges };
  }
  return { result, containerChanges };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Advisory check for portainer_set_stack_env: does the compose file
// actually reference a given env key anywhere, as ${KEY} / ${KEY:-def} /
// ${KEY:?msg} or a bare $KEY? A key that's set but never referenced is a
// silent no-op -- Portainer stores the value, but nothing in the compose
// file ever reads it. False negatives are the safe failure mode here (at
// worst, no warning for a reference style this regex doesn't recognize);
// false positives are not, so this stays permissive rather than trying
// to fully parse compose interpolation syntax.
export function findUnreferencedEnvKeys(
  composeContent: string,
  keys: string[],
): string[] {
  return keys.filter((key) => {
    const esc = escapeRegExp(key);
    const pattern = new RegExp(
      `\\$\\{${esc}(?:[:?][^}]*)?\\}|\\$${esc}(?![A-Za-z0-9_])`,
    );
    return !pattern.test(composeContent);
  });
}

// Merges advisory env-reference warnings onto a set_stack_env response
// without clobbering it -- same pattern as withImagePrune.
export function withEnvWarnings(result: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), envWarnings: warnings };
  }
  return { result, envWarnings: warnings };
}

// Portainer's `Prune` field on PUT /stacks/{id} and .../git/redeploy only
// takes effect for Swarm stacks (Type 1) -- its own Swagger description says
// "only available for Swarm stacks". Sending prune: true against a Compose
// stack (Type 2) is accepted and silently does nothing, so a caller believing
// it removes orphaned containers from a Compose stack is silently wrong.
export function pruneNoopWarning(
  stackType: number,
  pruneRequested: boolean,
): string | null {
  if (!pruneRequested || stackType === 1) return null;
  return (
    "prune: true has no effect on this stack -- Portainer's Prune option " +
    "only applies to Swarm stacks (Type 1), not Compose (Type 2). Orphaned " +
    "containers from services removed or profile-gated out of the compose " +
    "file are not cleaned up automatically. To find and remove them: " +
    "portainer_list_containers with label=com.docker.compose.project=<stack " +
    "name> and all=true, then portainer_container_delete on any that no " +
    "longer belong."
  );
}

// Merges an advisory prune-no-op warning onto a response without clobbering
// it -- same additive pattern as withEnvWarnings/withImagePrune.
export function withPruneWarning(
  result: unknown,
  warning: string | null,
): unknown {
  if (warning === null) return result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), pruneWarning: warning };
  }
  return { result, pruneWarning: warning };
}

export interface EnvSideRaw {
  found: boolean;
  value: string;
}

export interface EnvSideResult {
  found: boolean;
  empty: boolean;
}

export interface CompareEnvValuesResult {
  match: boolean;
  a: EnvSideResult;
  b: EnvSideResult;
}

// Pure comparison logic, separated from the HTTP fetch so it's unit
// testable without mocking a live Portainer instance. An empty or missing
// value on either side is never treated as a match, even against another
// empty/missing value — an unset var matching another unset var isn't a
// meaningful "these secrets agree" signal.
export function compareEnvValuesResult(
  rawA: EnvSideRaw,
  rawB: EnvSideRaw,
): CompareEnvValuesResult {
  const sideA: EnvSideResult = {
    found: rawA.found,
    empty: rawA.found && rawA.value === "",
  };
  const sideB: EnvSideResult = {
    found: rawB.found,
    empty: rawB.found && rawB.value === "",
  };
  const comparable = !sideA.empty && !sideB.empty && rawA.found && rawB.found;
  const match =
    comparable &&
    timingSafeEqual(
      createHash("sha256").update(rawA.value).digest(),
      createHash("sha256").update(rawB.value).digest(),
    );
  return { match, a: sideA, b: sideB };
}

// Docker multiplexes a non-TTY container's log stream into frames: a
// 1-byte stream type (0=stdin, 1=stdout, 2=stderr) + 3 zero-padding
// bytes + a 4-byte big-endian payload length, repeated once per write.
// A TTY-attached container's stream carries NO such framing -- just raw
// terminal bytes. Demuxing must run on the raw response BYTES (see the
// `raw: true` request() branch) rather than an already-UTF-8-decoded
// string: any payload over 127 bytes puts a byte >= 0x80 in the length
// field, which UTF-8 decoding would have already mangled into U+FFFD
// before this function ever saw it.
//
// Rather than an extra inspect call to check Config.Tty, validate that
// the buffer parses as a complete, gapless sequence of valid frames; if
// it doesn't (a declared length would overrun the buffer, or a type
// byte is out of range), treat the whole buffer as unframed (TTY) text
// instead. A genuine TTY stream essentially never coincidentally
// satisfies "every single frame boundary lines up" for its entire
// length, so this false-positives only in the deliberately-adversarial
// case, never on real log output.
export function demuxDockerLogs(buf: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) return buf.toString("utf8");
    const streamType = buf.readUInt8(offset);
    if (
      streamType > 2 ||
      buf.readUInt8(offset + 1) !== 0 ||
      buf.readUInt8(offset + 2) !== 0 ||
      buf.readUInt8(offset + 3) !== 0
    ) {
      return buf.toString("utf8");
    }
    const length = buf.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buf.length) return buf.toString("utf8");
    chunks.push(buf.subarray(payloadStart, payloadEnd));
    offset = payloadEnd;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const RELATIVE_DURATION_RE = /^(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;

// Docker's raw HTTP API only accepts `since`/`until` as Unix timestamps
// (whole seconds) -- forcing a caller to compute one by hand is exactly
// the kind of friction the rest of this tool's fixes exist to remove.
// Mirrors `docker logs --since`'s own CLI convention instead of inventing
// a new one: a bare integer is an absolute Unix timestamp, an RFC3339
// datetime is absolute, and a Go-style relative duration (combinable
// d/h/m/s units, e.g. "10m", "1h30m", "45s") counts back from `now`.
export function parseDockerTimeFilter(
  value: string,
  now: number = Date.now(),
): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const rfc3339Ms = Date.parse(value);
  if (!Number.isNaN(rfc3339Ms)) {
    return Math.floor(rfc3339Ms / 1000);
  }
  const match = RELATIVE_DURATION_RE.exec(value);
  if (match && (match[1] || match[2] || match[3] || match[4])) {
    const days = match[1] ? Number(match[1].slice(0, -1)) : 0;
    const hours = match[2] ? Number(match[2].slice(0, -1)) : 0;
    const minutes = match[3] ? Number(match[3].slice(0, -1)) : 0;
    const seconds = match[4] ? Number(match[4].slice(0, -1)) : 0;
    const totalSeconds = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
    return Math.floor(now / 1000) - totalSeconds;
  }
  throw new Error(
    `Invalid time filter "${value}": expected a Unix timestamp, an RFC3339 datetime, or a relative duration like "10m" / "1h30m" / "45s".`,
  );
}

export interface PullProgressResult {
  status: "downloaded" | "up-to-date" | "unknown";
  statusLine?: string;
}

// Docker's POST /images/create response body is newline-delimited JSON
// progress objects, not one JSON document -- request<T>()'s JSON branch
// can't parse it, hence the `raw: true` fetch + manual parse here. The
// endpoint also returns HTTP 200 even when the pull fails (e.g. a
// nonexistent tag), reporting the failure as an `{"error": ...}` object
// mid-stream -- this must be scanned for and thrown, or a failed pull looks
// identical to a successful one to the caller.
export function parsePullProgress(raw: string): PullProgressResult {
  let statusLine: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate a stray non-JSON line rather than fail the whole pull
    }
    if (obj === null || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error.length > 0) {
      throw new Error(`Image pull failed: ${rec.error}`);
    }
    if (typeof rec.status === "string" && rec.status.startsWith("Status: ")) {
      statusLine = rec.status;
    }
  }
  if (statusLine?.includes("Downloaded newer image")) {
    return { status: "downloaded", statusLine };
  }
  if (statusLine?.includes("Image is up to date")) {
    return { status: "up-to-date", statusLine };
  }
  return { status: "unknown", statusLine };
}

export class PortainerClient {
  private readonly insecureDispatcher: Agent | undefined;

  constructor(private readonly config: PortainerConfig) {
    if (!config.verifyTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    opts?: { noRedact?: boolean; raw?: boolean },
  ): Promise<T> {
    const url = new URL(path, this.config.url);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      "X-API-Key": this.config.apiKey,
      Accept: "application/json",
    };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const init: PortainerRequestInit = {
      method: method as Dispatcher.HttpMethod,
      headers,
    };
    // Only attach `body` when we actually have one. Setting `init.body =
    // undefined` causes undici to still emit `Content-Length: 0`, which
    // Docker's POST /containers/{id}/start rejects as "non-empty request
    // body" (deprecated v1.22, removed v1.24). Other endpoints tolerate
    // it, but start is uniquely strict — see the Docker engine API ref.
    if (bodyStr !== undefined) {
      init.body = bodyStr;
    }
    if (this.insecureDispatcher) {
      init.dispatcher = this.insecureDispatcher;
    }
    // Must be undici's own request(), NOT global fetch. Node's global fetch
    // is backed by the undici copy bundled inside Node, so an Agent built
    // from this package is a foreign object to it and the `dispatcher`
    // option may be silently ignored — which drops
    // `connect.rejectUnauthorized: false` and makes every call to a
    // self-signed Portainer fail with a bare "fetch failed". That is exactly
    // what the node:22-alpine -> node:26-alpine bump did in production.
    // Going through undici directly keeps the Agent and the request in one
    // module instance, so the dispatcher is always honored.
    const res = await undiciRequest(url, init);
    const status = res.statusCode;
    if (status < 200 || status >= 300) {
      const errBody = await res.body.text().catch(() => "");
      // 2000 chars, not the original 200 -- Portainer's own validation and
      // git-auth error messages routinely run past 200 on their own (see
      // setStackEnv's git-managed error wrapper below, which is itself
      // longer than that), so the old cap was silently truncating the one
      // piece of diagnostic detail a caller needs to actually fix a
      // failed call. Still bounded, so a pathological HTML error page
      // can't blow up the response.
      throw new Error(
        `Portainer ${status} for ${method} ${path}: ${errBody.slice(0, 2000)}`,
      );
    }
    // Raw-bytes branch, bypassing both the JSON and text branches below.
    // Exists for containerLogs' demuxer, which must see Docker's stream
    // frame headers before any text decoding touches them -- decoding to
    // UTF-8 first would corrupt any length byte >= 0x80 into U+FFFD.
    if (opts?.raw) {
      return Buffer.from(await res.body.arrayBuffer()) as unknown as T;
    }
    const ctypeHeader = res.headers["content-type"];
    const ctype = Array.isArray(ctypeHeader)
      ? (ctypeHeader[0] ?? "")
      : (ctypeHeader ?? "");
    if (ctype.includes("application/json")) {
      const data = (await res.body.json()) as unknown;
      return (opts?.noRedact ? data : redactSecrets(data)) as T;
    }
    return (await res.body.text()) as unknown as T;
  }

  async listEndpoints(): Promise<unknown> {
    return this.request("GET", "/api/endpoints");
  }

  async listStacks(endpointId?: number): Promise<unknown> {
    const query: Record<string, string> = {};
    if (endpointId !== undefined) {
      query.filters = JSON.stringify({ EndpointId: endpointId });
    }
    return this.request("GET", "/api/stacks", query);
  }

  // Full stack details for MCP callers, per the tool's own advertised
  // description, means including StackFileContent — the plain /stacks/{id}
  // GET doesn't carry it (it's a separate endpoint). include_file defaults
  // to true; the caller opts OUT with include_file: false, not in. On a
  // fetch failure (rare: the stack record still returned fine) fail soft
  // with StackFileError rather than silently omitting the field — a
  // silent omission is exactly the "accepted and does nothing" complaint
  // this fix exists to close. Deliberately not `noRedact: true`: this
  // value reaches the MCP wire, unlike the internal round-trip fetches
  // elsewhere in this file (redeployStack, setStackEnv) that feed a PUT
  // right back to Portainer.
  async getStack(
    id: number,
    opts: { includeFile?: boolean } = {},
  ): Promise<unknown> {
    const stack = await this.request<Record<string, unknown>>(
      "GET",
      `/api/stacks/${id}`,
    );
    if (opts.includeFile === false) return stack;
    try {
      const file = await this.request<{ StackFileContent: string }>(
        "GET",
        `/api/stacks/${id}/file`,
      );
      return { ...stack, StackFileContent: file.StackFileContent };
    } catch (err) {
      return {
        ...stack,
        StackFileError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listContainers(
    endpointId: number,
    opts: ContainerListOptions = {},
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/json`,
      containerListQuery(opts),
    );
  }

  async getContainer(
    endpointId: number,
    containerId: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/json`,
    );
  }

  // Internal-only: fetches one raw (unredacted) env var value for the
  // fingerprint comparison below. Never returned to an MCP caller directly —
  // only its hash is. See compareEnvValues.
  private async getContainerEnvValueRaw(
    endpointId: number,
    containerId: string,
    varName: string,
  ): Promise<{ found: boolean; value: string }> {
    interface RawContainer {
      Config?: { Env?: string[] };
    }
    const container = await this.request<RawContainer>(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/json`,
      undefined,
      undefined,
      { noRedact: true },
    );
    const prefix = `${varName}=`;
    const entry = (container.Config?.Env ?? []).find((e) =>
      e.startsWith(prefix),
    );
    return entry === undefined
      ? { found: false, value: "" }
      : { found: true, value: entry.slice(prefix.length) };
  }

  // Compares two containers' env values for equality without either value
  // (or a hash of it) ever crossing the MCP wire — only a boolean. Fetches
  // both raw values server-side; see compareEnvValuesResult for the
  // comparison logic itself.
  async compareEnvValues(
    a: { endpointId: number; containerId: string; varName: string },
    b: { endpointId: number; containerId: string; varName: string },
  ): Promise<CompareEnvValuesResult> {
    const [rawA, rawB] = await Promise.all([
      this.getContainerEnvValueRaw(a.endpointId, a.containerId, a.varName),
      this.getContainerEnvValueRaw(b.endpointId, b.containerId, b.varName),
    ]);
    return compareEnvValuesResult(rawA, rawB);
  }

  async containerLogs(
    endpointId: number,
    containerId: string,
    tail: number,
    opts: { since?: string; until?: string } = {},
  ): Promise<string> {
    const query: Record<string, string> = {
      stdout: "true",
      stderr: "true",
      tail: String(tail),
      timestamps: "true",
    };
    if (opts.since !== undefined) {
      query.since = String(parseDockerTimeFilter(opts.since));
    }
    if (opts.until !== undefined) {
      query.until = String(parseDockerTimeFilter(opts.until));
    }
    const raw = await this.request<Buffer>(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/logs`,
      query,
      undefined,
      { raw: true },
    );
    return demuxDockerLogs(raw);
  }

  // Pulls an image without touching any container -- splits the slow part
  // of a recreate-with-pull off from the fast part, so a large image no
  // longer risks blowing the MCP client's own tool-call timeout on a
  // destructive recreate call. See portainer_recreate_container's
  // description for the paired usage.
  async pullImage(
    endpointId: number,
    image: string,
  ): Promise<PullProgressResult> {
    const raw = await this.request<Buffer>(
      "POST",
      `/api/endpoints/${endpointId}/docker/images/create`,
      { fromImage: image },
      undefined,
      { raw: true },
    );
    return parsePullProgress(raw.toString("utf8"));
  }

  async systemStatus(): Promise<unknown> {
    return this.request("GET", "/api/system/status");
  }

  async listVolumes(
    endpointId: number,
    filters?: { dangling?: boolean; name?: string },
  ): Promise<unknown> {
    // Docker's /volumes endpoint accepts a `filters` query param that's
    // a JSON-encoded map of field -> string[] values. Build it from
    // the caller's high-level filter inputs.
    const dockerFilters: Record<string, string[]> = {};
    if (filters?.dangling !== undefined) {
      dockerFilters.dangling = [String(filters.dangling)];
    }
    if (filters?.name) {
      dockerFilters.name = [filters.name];
    }
    const query: Record<string, string> = {};
    if (Object.keys(dockerFilters).length > 0) {
      query.filters = JSON.stringify(dockerFilters);
    }
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/volumes`,
      query,
    );
  }

  async inspectVolume(
    endpointId: number,
    volumeName: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/volumes/${encodeURIComponent(volumeName)}`,
    );
  }

  async listNetworks(
    endpointId: number,
    filters?: { dangling?: boolean; name?: string },
  ): Promise<unknown> {
    const dockerFilters: Record<string, string[]> = {};
    if (filters?.dangling !== undefined) {
      dockerFilters.dangling = [String(filters.dangling)];
    }
    if (filters?.name) {
      dockerFilters.name = [filters.name];
    }
    const query: Record<string, string> = {};
    if (Object.keys(dockerFilters).length > 0) {
      query.filters = JSON.stringify(dockerFilters);
    }
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/networks`,
      query,
    );
  }

  async inspectNetwork(
    endpointId: number,
    networkId: string,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/networks/${encodeURIComponent(networkId)}`,
    );
  }

  async pruneNetworks(endpointId: number): Promise<unknown> {
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/networks/prune`,
    );
  }

  async listImages(endpointId: number): Promise<unknown> {
    // Portainer-NATIVE handler (not the Docker proxy tree) — same shape
    // as recreateContainer's /api/docker/{id}/... path. withUsage adds a
    // `used` boolean per image (true if >=1 container references it),
    // which is the whole point: it's what lets a caller tell "unused"
    // apart from "backing something" without cross-referencing every
    // container's Image/ImageID by hand.
    return this.request("GET", `/api/docker/${endpointId}/images`, {
      withUsage: "true",
    });
  }

  async pruneImages(
    endpointId: number,
    opts: ImagePruneOptions = {},
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/images/prune`,
      imagePruneQuery(opts),
    );
  }

  // Dangling-only prune run automatically after a redeploy/recreate that
  // may have pulled a new image digest (docker-deployments.md rule 5:
  // every push that changes the digest bounces the container and leaves
  // the old digest dangling). Never allUnused here — that branch stays an
  // explicit, separately-confirmed opt-in via portainer_prune_images. A
  // prune failure must not fail the redeploy that already succeeded — log
  // to stderr and surface the failure in the merged response instead of
  // throwing.
  private async pruneDanglingAfterRedeploy(
    endpointId: number,
  ): Promise<unknown> {
    try {
      return await this.pruneImages(endpointId, { allUnused: false });
    } catch (err) {
      console.error(
        `portainer-mcp: post-redeploy image prune failed for endpoint ${endpointId}: ${String(err)}`,
      );
      return { error: String(err) };
    }
  }

  // Best-effort snapshot of a stack's containers (name + id) for the
  // before/after recreation diff. Returns null on any failure rather
  // than throwing or returning [] -- [] is a real, meaningful state (a
  // stack whose only service is profile-gated and never started), so it
  // must stay distinguishable from "couldn't read the container list".
  private async trySnapshotStackContainers(
    endpointId: number,
    stackName: string,
  ): Promise<ContainerIdentity[] | null> {
    try {
      const containers = await this.listContainers(endpointId, {
        label: `com.docker.compose.project=${stackName}`,
        all: true,
      });
      if (!Array.isArray(containers)) return null;
      return containers.map((c) => {
        const o = c as Record<string, unknown>;
        const names = Array.isArray(o.Names) ? o.Names : [];
        const name = typeof names[0] === "string" ? names[0] : String(o.Id);
        return { name, id: String(o.Id) };
      });
    } catch {
      return null;
    }
  }

  async containerStart(
    endpointId: number,
    containerId: string,
  ): Promise<unknown> {
    // Send a tiny "{}" body (2 bytes) as a workaround for Docker's
    // /start strictness. Docker's documented check is
    // `r.ContentLength > 7 || r.ContentLength == -1` — but in
    // practice (Synology Docker, observed 2026-05-06) requests with
    // Content-Length: 0 still trigger the "non-empty request body
    // was deprecated since API v1.22 and removed in v1.24" error.
    // A 2-byte empty-JSON body satisfies the size threshold (2 ≤ 7)
    // and the /start handler ignores body content entirely (it only
    // reads checkpoint/checkpoint-dir from the query string).
    // Earlier attempt (commit 3592653) tried to suppress
    // Content-Length: 0 from the fetch layer; undici emits it
    // unconditionally for POST regardless of init.body presence,
    // so that approach was a no-op. This shipping the body is the
    // empirical fix that actually works.
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/start`,
      undefined,
      {},
    );
  }

  async containerStop(
    endpointId: number,
    containerId: string,
    timeout?: number,
  ): Promise<unknown> {
    const query = timeout !== undefined ? { t: String(timeout) } : undefined;
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/stop`,
      query,
    );
  }

  async containerRestart(
    endpointId: number,
    containerId: string,
    timeout?: number,
  ): Promise<unknown> {
    const query = timeout !== undefined ? { t: String(timeout) } : undefined;
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/restart`,
      query,
    );
  }

  async containerKill(
    endpointId: number,
    containerId: string,
    signal?: string,
  ): Promise<unknown> {
    const query = signal ? { signal } : undefined;
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/kill`,
      query,
    );
  }

  async containerDelete(
    endpointId: number,
    containerId: string,
    opts: { force?: boolean; removeVolumes?: boolean } = {},
  ): Promise<unknown> {
    const query: Record<string, string> = {};
    if (opts.force) query.force = "true";
    if (opts.removeVolumes) query.v = "true";
    return this.request(
      "DELETE",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}`,
      Object.keys(query).length > 0 ? query : undefined,
    );
  }

  // Shared by file-based update endpoints. Reads the stack with
  // noRedact so the caller gets the raw env for round-trip, and
  // refuses git-managed or non-Compose/Swarm stacks (the file-based
  // PUT would silently detach git stacks via stack.GitConfig = nil).
  private async assertFileBasedStack(
    stackId: number,
    op: string,
  ): Promise<{
    Id: number;
    Type: number;
    EndpointId: number;
    Name: string;
    Env?: unknown[];
  }> {
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: unknown[];
      GitConfig?: unknown;
    }
    const stack = await this.request<RawStack>(
      "GET",
      `/api/stacks/${stackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (stack.GitConfig != null) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) is git-managed. Use the git redeploy endpoint instead — file-based PUT would silently detach it from git.`,
      );
    }
    if (stack.Type !== 1 && stack.Type !== 2) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; ${op} supports only Compose (2) and Swarm (1). Kubernetes stacks (3) require a different endpoint.`,
      );
    }
    return stack;
  }

  async redeployStack(
    stackId: number,
    opts: { pullImage: boolean; prune: boolean },
  ): Promise<unknown> {
    const stack = await this.assertFileBasedStack(stackId, "redeploy");
    const before = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    const file = await this.request<{ StackFileContent: string }>(
      "GET",
      `/api/stacks/${stackId}/file`,
      undefined,
      undefined,
      { noRedact: true },
    );
    const result = await this.request(
      "PUT",
      `/api/stacks/${stackId}`,
      { endpointId: String(stack.EndpointId) },
      {
        stackFileContent: file.StackFileContent,
        env: stack.Env ?? [],
        repullImageAndRedeploy: opts.pullImage,
        prune: opts.prune,
      },
    );
    const imagePrune = await this.pruneDanglingAfterRedeploy(stack.EndpointId);
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(
        withImagePrune(result, imagePrune),
        pruneNoopWarning(stack.Type, opts.prune),
      ),
      before,
      after,
    );
  }

  async updateStackFile(
    stackId: number,
    composeContent: string,
    opts: { pullImage: boolean; prune: boolean },
  ): Promise<unknown> {
    const stack = await this.assertFileBasedStack(stackId, "update");
    const before = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    const result = await this.request(
      "PUT",
      `/api/stacks/${stackId}`,
      { endpointId: String(stack.EndpointId) },
      {
        stackFileContent: composeContent,
        env: stack.Env ?? [],
        repullImageAndRedeploy: opts.pullImage,
        prune: opts.prune,
      },
    );
    const imagePrune = await this.pruneDanglingAfterRedeploy(stack.EndpointId);
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(
        withImagePrune(result, imagePrune),
        pruneNoopWarning(stack.Type, opts.prune),
      ),
      before,
      after,
    );
  }

  async redeployGitStack(
    stackId: number,
    opts: { pullImage: boolean; prune?: boolean },
  ): Promise<unknown> {
    interface RawAuth {
      Username?: string;
      AuthorizationType?: number;
    }
    interface RawGitConfig {
      ReferenceName?: string;
      Authentication?: RawAuth | null;
    }
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: unknown[];
      GitConfig?: RawGitConfig | null;
      Option?: { Prune?: boolean } | null;
    }
    const stack = await this.request<RawStack>(
      "GET",
      `/api/stacks/${stackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (stack.GitConfig == null) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) is not git-managed. Use portainer_redeploy_stack for file-based stacks.`,
      );
    }
    if (stack.Type !== 1 && stack.Type !== 2) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; git redeploy supports only Compose (2) and Swarm (1). Kubernetes git stacks have a different update flow.`,
      );
    }
    const auth = stack.GitConfig.Authentication;
    const payload: Record<string, unknown> = {
      // All four are unconditionally assigned by the handler — omitting wipes
      // them. Round-trip the existing values so a "redeploy as-is" call doesn't
      // silently destroy the stack's git/env config.
      repositoryReferenceName: stack.GitConfig.ReferenceName ?? "",
      env: stack.Env ?? [],
      repullImageAndRedeploy: opts.pullImage,
      prune: opts.prune ?? stack.Option?.Prune ?? false,
      repositoryAuthentication: auth != null,
    };
    const effectivePrune = payload.prune as boolean;
    if (auth != null) {
      // Saved password is preserved on the server side when password is
      // empty AND existing GitConfig.Authentication is set, per the handler.
      // We can never read the saved password back (it's blanked on response),
      // so we always send empty and let Portainer re-use what it has.
      payload.repositoryUsername = auth.Username ?? "";
      payload.repositoryPassword = "";
      if (auth.AuthorizationType !== undefined) {
        payload.repositoryAuthorizationType = auth.AuthorizationType;
      }
    }
    const before = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    const result = await this.request(
      "PUT",
      `/api/stacks/${stackId}/git/redeploy`,
      { endpointId: String(stack.EndpointId) },
      payload,
    );
    const imagePrune = await this.pruneDanglingAfterRedeploy(stack.EndpointId);
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(
        withImagePrune(result, imagePrune),
        pruneNoopWarning(stack.Type, effectivePrune),
      ),
      before,
      after,
    );
  }

  async recreateContainer(
    endpointId: number,
    containerRef: string,
    opts: { pullImage: boolean },
  ): Promise<unknown> {
    // Note: this is a Portainer-NATIVE handler (not under the Docker proxy
    // tree). The path is `/api/docker/{id}/containers/{containerId}/recreate`,
    // NOT `/api/endpoints/{id}/docker/containers/{containerId}/recreate`. The
    // proxy tree at /api/endpoints/{id}/docker/ is for direct Docker API
    // passthroughs; recreate is a Portainer composition that pulls the
    // image, stops + removes the old container, and recreates with the
    // same Config + HostConfig.
    //
    // Inspect-first to resolve the caller's ref (name, short ID, or full ID)
    // to the canonical 64-char Docker ID. The recreate flow internally
    // disconnects the old container from its networks; that disconnect call
    // requires the full ID and 500s with a misleading "endpoint not found"
    // when given anything else. See PORTAINER-API.md gotcha
    // "POST /containers/{id}/recreate requires the full container ID".
    const resolved = await this.request<{ Id: string }>(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerRef}/json`,
    );
    const result = await this.request(
      "POST",
      `/api/docker/${endpointId}/containers/${resolved.Id}/recreate`,
      undefined,
      { PullImage: opts.pullImage },
    );
    const imagePrune = await this.pruneDanglingAfterRedeploy(endpointId);
    return withImagePrune(result, imagePrune);
  }

  async createStack(
    endpointId: number,
    spec: {
      name: string;
      composeContent: string;
      env?: Array<{ name: string; value: string }>;
    },
  ): Promise<unknown> {
    // Pre-flight name-collision check across all stacks on this endpoint.
    // Catches two failure modes:
    //   1. Portainer's silent-nuke trap on standalone/string create —
    //      checkAndCleanStackDupFromSwarm deletes any existing Swarm stack
    //      with the same name on the same endpoint without warning.
    //   2. Honest user error / LLM hallucinating a stack name that
    //      already exists. Either way, refusing here is safer than
    //      letting Portainer silently destroy state.
    interface RawStackSummary {
      Name: string;
      EndpointId: number;
    }
    const existing = await this.request<RawStackSummary[]>(
      "GET",
      "/api/stacks",
      { filters: JSON.stringify({ EndpointId: endpointId }) },
    );
    const collision = existing.find((s) => s.Name === spec.name);
    if (collision) {
      throw new Error(
        `Stack "${spec.name}" already exists on endpoint ${endpointId}. Refusing to create — use portainer_redeploy_stack to update an existing stack, or portainer_delete_stack first if you really want to recreate from scratch.`,
      );
    }
    return this.request(
      "POST",
      "/api/stacks/create/standalone/string",
      { endpointId: String(endpointId) },
      {
        Name: spec.name,
        StackFileContent: spec.composeContent,
        Env: spec.env ?? [],
      },
    );
  }

  async createGitStack(
    endpointId: number,
    spec: {
      name: string;
      repositoryUrl: string;
      referenceName?: string;
      composePath?: string;
      env?: Array<{ name: string; value: string }>;
      username?: string;
      password?: string;
      gitCredentialId?: number;
      autoUpdateInterval?: string;
      forcePullImage?: boolean;
    },
  ): Promise<unknown> {
    if (
      spec.gitCredentialId !== undefined &&
      (spec.username !== undefined || spec.password !== undefined)
    ) {
      throw new Error(
        "Provide either git_credential_id or username/password for git auth, not both.",
      );
    }
    // Same pre-flight name-collision check as createStack — refuse if any
    // stack on this endpoint already shares the name. Catches the silent
    // Swarm-stack nuke trap and prevents accidental overwrites.
    interface RawStackSummary {
      Name: string;
      EndpointId: number;
    }
    const existing = await this.request<RawStackSummary[]>(
      "GET",
      "/api/stacks",
      { filters: JSON.stringify({ EndpointId: endpointId }) },
    );
    if (existing.find((s) => s.Name === spec.name)) {
      throw new Error(
        `Stack "${spec.name}" already exists on endpoint ${endpointId}. Refusing to create — use portainer_redeploy_git_stack to update an existing git stack, or portainer_delete_stack first if you really want to recreate from scratch.`,
      );
    }
    const body: Record<string, unknown> = {
      Name: spec.name,
      RepositoryURL: spec.repositoryUrl,
      RepositoryReferenceName: spec.referenceName ?? "refs/heads/main",
      ComposeFile: spec.composePath ?? "docker-compose.yml",
      Env: spec.env ?? [],
    };
    // Only set the auth fields if a credential was provided, one way or the
    // other. Public repos don't need them; passing empty strings would still
    // flip RepositoryAuthentication=true and could confuse Portainer's
    // internal credential resolution.
    if (spec.gitCredentialId !== undefined) {
      // References an existing stored Portainer credential (Settings > Git
      // credentials) by id — nothing secret transits this call. Field name
      // confirmed 2026-08-19 by reading Portainer's served frontend bundle
      // (matches the read-side GitConfig.Authentication.GitCredentialID
      // shape) and live-verified against CE 2.39.6 with a throwaway
      // create-stack call.
      body.RepositoryAuthentication = true;
      body.RepositoryGitCredentialID = spec.gitCredentialId;
    } else if (spec.username !== undefined || spec.password !== undefined) {
      body.RepositoryAuthentication = true;
      body.RepositoryUsername = spec.username ?? "";
      body.RepositoryPassword = spec.password ?? "";
    }
    // AutoUpdateSettings per the pinned Swagger spec (JobID/Webhook are
    // server-assigned, never sent by us). Only set when an interval is
    // given — ForcePullImage alone has nothing to attach to without a
    // poll interval. Confirmed no Registries field exists anywhere on
    // this endpoint's payload (composeStackFromGitRepositoryPayload):
    // AutoUpdate here is image-pull-only, no registry-credential wiring
    // is available through this call.
    if (spec.autoUpdateInterval) {
      body.AutoUpdate = {
        Interval: spec.autoUpdateInterval,
        ForcePullImage: spec.forcePullImage ?? false,
      };
    }
    return this.request(
      "POST",
      "/api/stacks/create/standalone/repository",
      { endpointId: String(endpointId) },
      body,
    );
  }

  async convertStackToGit(
    sourceStackId: number,
    spec: {
      repositoryUrl: string;
      referenceName?: string;
      composePath?: string;
      username?: string;
      password?: string;
      gitCredentialId?: number;
      autoUpdateInterval?: string;
      forcePullImage?: boolean;
      confirmName: string;
    },
  ): Promise<unknown> {
    // Validate up front, before the source stack is touched. createGitStack
    // repeats this check, but by then the delete below would already have
    // happened — exactly the atomicity risk this tool's own docs warn about.
    if (
      spec.gitCredentialId !== undefined &&
      (spec.username !== undefined || spec.password !== undefined)
    ) {
      throw new Error(
        "Provide either git_credential_id or username/password for git auth, not both.",
      );
    }
    interface RawEnvEntry {
      name?: string;
      Name?: string;
      value?: string;
      Value?: string;
    }
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: RawEnvEntry[];
      GitConfig?: unknown;
    }
    // Step 1: Fetch source with raw env (noRedact) so we can carry the
    // real secret values into the new stack's env without ever exposing
    // them to the MCP caller.
    const source = await this.request<RawStack>(
      "GET",
      `/api/stacks/${sourceStackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (source.GitConfig != null) {
      throw new Error(
        `Stack ${sourceStackId} (${source.Name}) is already git-managed. Use portainer_redeploy_git_stack to update it instead.`,
      );
    }
    if (source.Type !== 1 && source.Type !== 2) {
      throw new Error(
        `Stack ${sourceStackId} (${source.Name}) has Type ${source.Type}; convert supports only Compose (2) and Swarm (1).`,
      );
    }
    // Two-factor confirm: caller must spell the source stack's name.
    if (source.Name !== spec.confirmName) {
      throw new Error(
        `Name mismatch: stack ${sourceStackId} is "${source.Name}", caller supplied confirm_name="${spec.confirmName}". Refusing to convert. Re-call with the correct name.`,
      );
    }
    // Capture the source compose content for a recovery payload if the
    // create step fails after delete. Best-effort — proceed if it fails.
    let composeContent = "";
    try {
      const file = await this.request<{ StackFileContent: string }>(
        "GET",
        `/api/stacks/${sourceStackId}/file`,
        undefined,
        undefined,
        { noRedact: true },
      );
      composeContent = file.StackFileContent;
    } catch {
      // Recovery payload will lack compose content; tolerable.
    }
    // Snapshot what we need before delete.
    const sourceName = source.Name;
    const sourceEndpoint = source.EndpointId;
    const sourceEnv: Array<{ name: string; value: string }> = (
      source.Env ?? []
    ).map((e) => ({
      name: (e.name ?? e.Name ?? "") as string,
      value: (e.value ?? e.Value ?? "") as string,
    }));
    // Step 2: Delete source. This frees the name so we can create the
    // new git-managed stack with the same Name (preserving any external
    // references like Claude Desktop's MCP config that targets the
    // stack's published port).
    await this.request("DELETE", `/api/stacks/${sourceStackId}`, {
      endpointId: String(sourceEndpoint),
    });
    // Step 3: Create the git-managed replacement with the captured env.
    try {
      return await this.createGitStack(sourceEndpoint, {
        name: sourceName,
        repositoryUrl: spec.repositoryUrl,
        referenceName: spec.referenceName,
        composePath: spec.composePath,
        env: sourceEnv,
        username: spec.username,
        password: spec.password,
        gitCredentialId: spec.gitCredentialId,
        autoUpdateInterval: spec.autoUpdateInterval,
        forcePullImage: spec.forcePullImage,
      });
    } catch (createErr) {
      // Recovery payload — env keys only (NEVER values; we don't want
      // secrets landing in tool-call logs even on the failure path).
      // Compose content is included so the user can recreate the
      // file-based stack manually via portainer_create_stack and re-add
      // the env values via the Portainer UI.
      const envKeys = sourceEnv.map((e) => e.name).join(", ");
      const origMsg =
        createErr instanceof Error ? createErr.message : String(createErr);
      throw new Error(
        `Conversion failed AFTER source stack was deleted. The source stack "${sourceName}" (id ${sourceStackId}) on endpoint ${sourceEndpoint} no longer exists. To recover: re-run portainer_create_stack with name="${sourceName}", endpoint_id=${sourceEndpoint}, the compose YAML below, then re-add the env vars [${envKeys}] via the Portainer UI (their values are NOT included in this message — they remain protected). Original create error: ${origMsg}\n\n--- ORIGINAL COMPOSE YAML ---\n${composeContent}\n--- END COMPOSE YAML ---`,
        { cause: createErr },
      );
    }
  }

  async setGitAuth(
    stackId: number,
    spec: { username: string; password: string } | { remove: true },
  ): Promise<unknown> {
    interface RawAuth {
      Username?: string;
      AuthorizationType?: number;
    }
    interface RawGitConfig {
      ReferenceName?: string;
      TLSSkipVerify?: boolean;
      Authentication?: RawAuth | null;
    }
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: unknown[];
      GitConfig?: RawGitConfig | null;
      AutoUpdate?: unknown;
    }
    // Fetch raw stack so we can round-trip env (wipe trap on this
    // endpoint per PORTAINER-API.md) and existing AutoUpdate config
    // (also a wipe trap — handler does `stack.AutoUpdate = payload.AutoUpdate`
    // unconditional). noRedact required to preserve secret env values.
    const stack = await this.request<RawStack>(
      "GET",
      `/api/stacks/${stackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (stack.GitConfig == null) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) is not git-managed. set_git_auth only applies to git-managed stacks (use convert_stack_to_git first if you want to make a file-based stack git-managed).`,
      );
    }
    if (stack.Type !== 1 && stack.Type !== 2) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; set_git_auth supports only Compose (2) and Swarm (1).`,
      );
    }
    // Round-trip the wipe-trap fields from existing config. Empty
    // string for ReferenceName would silently blank the git ref.
    const payload: Record<string, unknown> = {
      env: stack.Env ?? [],
      autoUpdate: stack.AutoUpdate ?? null,
      repositoryReferenceName: stack.GitConfig.ReferenceName ?? "",
      tlsSkipVerify: stack.GitConfig.TLSSkipVerify ?? false,
    };
    if ("remove" in spec && spec.remove) {
      // RepositoryAuthentication=false makes the handler set
      // stack.GitConfig.Authentication = nil, wiping any saved creds.
      payload.repositoryAuthentication = false;
    } else if ("username" in spec) {
      payload.repositoryAuthentication = true;
      payload.repositoryUsername = spec.username;
      payload.repositoryPassword = spec.password;
      // Default AuthorizationType is Basic (0) — covers GitHub PAT
      // (paste PAT as password, any non-empty username works).
    }
    // Endpoint required per the handler (passes `true` to RetrieveNumericQueryParameter)
    return this.request(
      "POST",
      `/api/stacks/${stackId}/git`,
      { endpointId: String(stack.EndpointId) },
      payload,
    );
  }

  async setStackEnv(
    stackId: number,
    changes: {
      set?: Array<{ name: string; value: string }>;
      remove?: string[];
      pullImage?: boolean;
    },
  ): Promise<unknown> {
    const setCount = changes.set?.length ?? 0;
    const removeCount = changes.remove?.length ?? 0;
    if (setCount === 0 && removeCount === 0) {
      throw new Error(
        "set_stack_env requires at least one entry in `set` or `remove`. Refusing no-op call.",
      );
    }
    interface RawEnvEntry {
      name?: string;
      Name?: string;
      value?: string;
      Value?: string;
    }
    interface RawAuth {
      Username?: string;
      AuthorizationType?: number;
    }
    interface RawGitConfig {
      ReferenceName?: string;
      Authentication?: RawAuth | null;
    }
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: RawEnvEntry[];
      GitConfig?: RawGitConfig | null;
      Option?: { Prune?: boolean } | null;
    }
    // Fetch the stack with raw env so we can read existing secret values
    // and merge the caller's changes without clobbering them.
    const stack = await this.request<RawStack>(
      "GET",
      `/api/stacks/${stackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (stack.Type !== 1 && stack.Type !== 2) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; set_stack_env supports only Compose (2) and Swarm (1).`,
      );
    }
    const before = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    // Normalize current env to lowercase {name, value} (Portainer returns
    // lowercase for /stacks endpoints — see scrubEnvArray for the same
    // dual-case handling).
    const currentEnv: Array<{ name: string; value: string }> = (
      stack.Env ?? []
    ).map((e) => ({
      name: (e.name ?? e.Name ?? "") as string,
      value: (e.value ?? e.Value ?? "") as string,
    }));
    // Apply remove first.
    const removeSet = new Set(changes.remove ?? []);
    const newEnv = currentEnv.filter((e) => !removeSet.has(e.name));
    // Apply set (upsert — overwrite by name, otherwise append).
    for (const entry of changes.set ?? []) {
      const idx = newEnv.findIndex((e) => e.name === entry.name);
      if (idx >= 0) {
        newEnv[idx] = entry;
      } else {
        newEnv.push(entry);
      }
    }
    const setKeys = (changes.set ?? []).map((e) => e.name);
    // Builds the "set but not referenced anywhere in the compose file"
    // advisory from a fetched compose string. Never throws -- called from
    // inside a try/catch on the git-managed path, and the file-based path
    // already has a guaranteed-successful fetch to reuse.
    const unreferencedWarnings = (composeContent: string): string[] =>
      findUnreferencedEnvKeys(composeContent, setKeys).map(
        (key) =>
          `"${key}" was set but is not referenced anywhere in the compose file ` +
          `(no \${${key}} or $${key}) -- the value will have no effect until the ` +
          `compose file references it.`,
      );
    // Detect file-based vs git-managed and route to the matching update
    // endpoint. Both trigger a synchronous redeploy because Portainer
    // can't change container env without restart, but neither pulls a
    // new image unless pullImage is true (env-only intent default).
    if (stack.GitConfig != null) {
      const auth = stack.GitConfig.Authentication;
      const payload: Record<string, unknown> = {
        // Round-trip the git config wipe-trap fields per
        // PORTAINER-API.md "Env round-trip" gotcha.
        repositoryReferenceName: stack.GitConfig.ReferenceName ?? "",
        env: newEnv,
        repullImageAndRedeploy: changes.pullImage ?? false,
        prune: stack.Option?.Prune ?? false,
        repositoryAuthentication: auth != null,
      };
      if (auth != null) {
        payload.repositoryUsername = auth.Username ?? "";
        // Empty password — Portainer reuses saved password if existing
        // GitConfig.Authentication is set.
        payload.repositoryPassword = "";
        if (auth.AuthorizationType !== undefined) {
          payload.repositoryAuthorizationType = auth.AuthorizationType;
        }
      }
      // git/redeploy always re-pulls from the remote first, regardless of
      // pullImage/RepullImageAndRedeploy -- confirmed against the pinned
      // Swagger spec (docs/specs/portainer.json: "Pull and redeploy a
      // stack via Git", no flag in stackGitRedployPayload to skip the
      // pull) and this repo's own docs/PORTAINER-API.md. So there is no
      // way to change env on a git-managed stack without live git
      // connectivity, full stop -- and the raw error on a broken git
      // credential is an opaque low-level git message that doesn't say
      // so. Wrap it (see PORTAINER-API.md "portainer_set_stack_env" for
      // the fuller writeup) rather than let the caller assume portainer-
      // mcp itself is broken.
      try {
        const result = await this.request(
          "PUT",
          `/api/stacks/${stackId}/git/redeploy`,
          { endpointId: String(stack.EndpointId) },
          payload,
        );
        // Advisory-only: this fetch exists solely to check whether the
        // `set` keys are referenced anywhere in the compose file, so a
        // failure here must never fail (or even affect) the env change
        // that already succeeded above.
        let warnings: string[] = [];
        if (setKeys.length > 0) {
          try {
            const file = await this.request<{ StackFileContent: string }>(
              "GET",
              `/api/stacks/${stackId}/file`,
            );
            warnings = unreferencedWarnings(file.StackFileContent);
          } catch {
            // Skip the warning if the file fetch fails; the env change
            // itself already succeeded and is what matters.
          }
        }
        const after = await this.trySnapshotStackContainers(
          stack.EndpointId,
          stack.Name,
        );
        return withContainerChanges(
          withEnvWarnings(result, warnings),
          before,
          after,
        );
      } catch (err) {
        throw new Error(
          `Env change on git-managed stack ${stackId} (${stack.Name}) failed. ` +
            `Env changes on a git-managed stack always route through Portainer's ` +
            `git-redeploy endpoint, which re-pulls from the remote first regardless ` +
            `of pull_image -- there is no way to change env here without live git ` +
            `connectivity. If this is a git auth/connectivity error, fix the stack's ` +
            `stored git credential (Portainer UI > Stacks > ${stack.Name} > git ` +
            `settings) and retry, or make the change directly via the Portainer UI. ` +
            `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    // File-based path: need to also round-trip the compose content.
    const file = await this.request<{ StackFileContent: string }>(
      "GET",
      `/api/stacks/${stackId}/file`,
      undefined,
      undefined,
      { noRedact: true },
    );
    const result = await this.request(
      "PUT",
      `/api/stacks/${stackId}`,
      { endpointId: String(stack.EndpointId) },
      {
        stackFileContent: file.StackFileContent,
        env: newEnv,
        repullImageAndRedeploy: changes.pullImage ?? false,
        prune: false,
      },
    );
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withEnvWarnings(result, unreferencedWarnings(file.StackFileContent)),
      before,
      after,
    );
  }

  async deleteStack(stackId: number, confirmName: string): Promise<unknown> {
    // Two-factor confirmation: the stack id has to resolve to a stack
    // whose Name matches the caller's confirmName. Catches "wrong stack
    // id" disasters where the LLM picked the wrong number.
    interface RawStack {
      Id: number;
      Name: string;
      EndpointId: number;
    }
    const stack = await this.request<RawStack>("GET", `/api/stacks/${stackId}`);
    if (stack.Name !== confirmName) {
      throw new Error(
        `Name mismatch: stack ${stackId} is "${stack.Name}", caller supplied confirm_name="${confirmName}". Refusing to delete. If you really want to delete this stack, re-call with the correct name.`,
      );
    }
    await this.request("DELETE", `/api/stacks/${stackId}`, {
      endpointId: String(stack.EndpointId),
    });
    return {
      ok: true,
      action: "delete",
      stack_id: stackId,
      name: stack.Name,
      endpoint_id: stack.EndpointId,
    };
  }
}

export function registerPortainerTools(
  server: McpServer,
  p: PortainerClient,
): void {
  registerSystemTools(server, p);

  server.registerTool(
    "portainer_list_stacks",
    {
      title: "Portainer: List Stacks",
      description:
        "List all stacks managed by Portainer, optionally filtered by endpoint and/or name. Compact projection by default (Id, Name, Type, EndpointId, Status, CreationDate, GitManaged); set full=true for the raw objects. name is a client-side substring match (Portainer's stacks endpoint has no server-side name filter, unlike list_containers).",
      inputSchema: z
        .object({
          endpoint_id: z
            .number()
            .int()
            .optional()
            .describe(
              "Optional endpoint ID to filter stacks to a single Docker host",
            ),
          name: z
            .string()
            .optional()
            .describe("Filter: stack name substring (case-insensitive)"),
          full: z
            .boolean()
            .optional()
            .describe(
              "Return complete stack objects (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, name, full }) => {
      const result = await p.listStacks(endpoint_id);
      const filtered =
        name && Array.isArray(result)
          ? filterStacksByName(result, name)
          : result;
      if (full || !Array.isArray(filtered)) return asText(filtered);
      return asText(filtered.map(compactStack));
    },
  );

  server.registerTool(
    "portainer_get_stack",
    {
      title: "Portainer: Get Stack",
      description:
        "Get full stack details (compose file content, env, status, git config) by stack ID. Compose file content (StackFileContent) is included by default; set include_file=false to skip the extra fetch when you only need status/env/git config.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID"),
          include_file: z
            .boolean()
            .optional()
            .describe(
              "Include compose file content (StackFileContent). Default true.",
            ),
        })
        .strict(),
    },
    async ({ stack_id, include_file }) =>
      asText(await p.getStack(stack_id, { includeFile: include_file })),
  );

  server.registerTool(
    "portainer_list_containers",
    {
      title: "Portainer: List Containers",
      description:
        "List containers in an endpoint (compact projection by default; set full=true for complete Docker JSON). Filter by name substring, label, or status. Set all=true to include stopped containers.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          all: z
            .boolean()
            .optional()
            .describe("Include stopped containers (default false)"),
          name: z
            .string()
            .optional()
            .describe("Filter: container name substring"),
          label: z
            .string()
            .optional()
            .describe(
              'Filter: label "key" or "key=value" — e.g. "com.docker.compose.project=myapp" lists a stack\'s containers',
            ),
          status: z
            .enum([
              "created",
              "restarting",
              "running",
              "removing",
              "paused",
              "exited",
              "dead",
            ])
            .optional()
            .describe("Filter by container status (implies all=true)"),
          full: z
            .boolean()
            .optional()
            .describe(
              "Return complete Docker JSON per container (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, all, name, label, status, full }) => {
      const result = await p.listContainers(endpoint_id, {
        all,
        name,
        label,
        status,
      });
      if (full || !Array.isArray(result)) return asText(result);
      return asText(result.map(compactContainer));
    },
  );

  server.registerTool(
    "portainer_get_container",
    {
      title: "Portainer: Get Container",
      description:
        "Get container details (state, config, env, ports, mounts) by ID or name. Compact projection by default; set full=true for the complete Docker inspect JSON (NetworkSettings internals, GraphDriver, and other low-value detail the compact view omits).",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          full: z
            .boolean()
            .optional()
            .describe(
              "Return the complete Docker inspect JSON (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, full }) => {
      const result = await p.getContainer(endpoint_id, container_id);
      return asText(full ? result : compactContainerInspect(result));
    },
  );

  server.registerTool(
    "portainer_compare_env_values",
    {
      title: "Portainer: Compare Two Env Values",
      description:
        "Check whether two containers' env var values are equal, without ever exposing either value. Fetches both raw values server-side, hashes them, and returns only match: true/false plus found/empty flags for each side — never the values or a hash of them. Use this instead of eyeballing two redacted portainer_get_container results when two services are supposed to share a secret (e.g. a shared bearer token between a client and the service it authenticates to) and you need to confirm they actually match. An empty or missing value on either side is never reported as a match, even against another empty/missing value.",
      inputSchema: z
        .object({
          a: z
            .object({
              endpoint_id: z.number().int().describe("Endpoint ID for side A"),
              container_id: z
                .string()
                .describe("Container ID or name for side A"),
              var_name: z
                .string()
                .describe("Env var name to compare on side A"),
            })
            .strict(),
          b: z
            .object({
              endpoint_id: z.number().int().describe("Endpoint ID for side B"),
              container_id: z
                .string()
                .describe("Container ID or name for side B"),
              var_name: z
                .string()
                .describe("Env var name to compare on side B"),
            })
            .strict(),
        })
        .strict(),
    },
    async ({ a, b }) =>
      asText(
        await p.compareEnvValues(
          {
            endpointId: a.endpoint_id,
            containerId: a.container_id,
            varName: a.var_name,
          },
          {
            endpointId: b.endpoint_id,
            containerId: b.container_id,
            varName: b.var_name,
          },
        ),
      ),
  );

  server.registerTool(
    "portainer_container_logs",
    {
      title: "Portainer: Container Logs",
      description:
        "Fetch a container's logs, timestamped, as clean newline-delimited text. Docker's stream-multiplexing frame headers (present on non-TTY containers) are stripped server-side before the result is returned. Bound the payload with since/until instead of guessing at a tail count when you want a specific time window.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          tail: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe("Number of log lines to return (default 100)"),
          since: z
            .string()
            .optional()
            .describe(
              'Only return logs at or after this time. Accepts a Unix timestamp (seconds), an RFC3339 datetime (e.g. "2026-08-28T20:00:00Z"), or a relative duration counted back from now (e.g. "10m", "1h30m", "45s") -- same convention as `docker logs --since`.',
            ),
          until: z
            .string()
            .optional()
            .describe(
              "Only return logs before this time. Same accepted formats as `since`.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, tail, since, until }) =>
      asText(
        await p.containerLogs(endpoint_id, container_id, tail ?? 100, {
          since,
          until,
        }),
      ),
  );

  server.registerTool(
    "portainer_list_volumes",
    {
      title: "Portainer: List Volumes",
      description:
        "List Docker volumes on an endpoint. Useful for spotting orphan/unused volumes accumulated from deleted stacks. Optional filters: `dangling: true` returns only volumes with no container reference (true orphans), `dangling: false` returns only in-use volumes, omit for all. `name` is a substring filter on volume name.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          dangling: z
            .boolean()
            .optional()
            .describe(
              "Filter by usage. true = only unused (no container references), false = only in-use, omit = all volumes.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "Substring filter on volume name (Docker's name filter).",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, dangling, name }) =>
      asText(await p.listVolumes(endpoint_id, { dangling, name })),
  );

  server.registerTool(
    "portainer_inspect_volume",
    {
      title: "Portainer: Inspect Volume",
      description:
        "Get full details for a single Docker volume — Mountpoint (host path), Driver, CreatedAt, Labels (including the Compose project label that maps to a stack), Scope, and Options. Use this to decide whether an unused volume is safe to remove (check Labels for the originating stack name; check Mountpoint size on disk if needed).",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          volume_name: z
            .string()
            .min(1)
            .describe(
              "Volume name (from portainer_list_volumes). Names with special characters are URL-encoded automatically.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, volume_name }) =>
      asText(await p.inspectVolume(endpoint_id, volume_name)),
  );

  server.registerTool(
    "portainer_list_networks",
    {
      title: "Portainer: List Networks",
      description:
        "List Docker networks on an endpoint. Useful for spotting orphan networks left behind by deleted stacks (Compose creates one network per project by default). Optional filters: `dangling: true` returns only networks not used by any container, `dangling: false` returns only in-use networks, omit for all. `name` is a substring filter on network name.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          dangling: z
            .boolean()
            .optional()
            .describe(
              "Filter by usage. true = only unused (no container references), false = only in-use, omit = all networks.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "Substring filter on network name (Docker's name filter).",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, dangling, name }) =>
      asText(await p.listNetworks(endpoint_id, { dangling, name })),
  );

  server.registerTool(
    "portainer_inspect_network",
    {
      title: "Portainer: Inspect Network",
      description:
        "Get full details for a single Docker network — Driver, Scope, IPAM config (subnets/gateways), connected Containers, and Labels (including the Compose project label that maps to a stack). Use this to decide whether an unused network is safe to remove.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          network_id: z
            .string()
            .min(1)
            .describe(
              "Network ID or name (from portainer_list_networks). Values with special characters are URL-encoded automatically.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, network_id }) =>
      asText(await p.inspectNetwork(endpoint_id, network_id)),
  );

  server.registerTool(
    "portainer_prune_networks",
    {
      title: "Portainer: Prune Networks",
      description:
        "Remove all Docker networks on an endpoint not used by any container (like `docker network prune`). Lower risk than volume pruning would be — an unused network holds no data to lose, and Compose recreates it automatically on the next redeploy if still needed. Still requires confirm: true, and a network can appear briefly unused during a stack redeploy's container-swap window — avoid running this immediately after a bulk redeploy across many stacks.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge this removes unused networks",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id }) => asText(await p.pruneNetworks(endpoint_id)),
  );

  server.registerTool(
    "portainer_list_images",
    {
      title: "Portainer: List Images",
      description:
        "List Docker images on an endpoint with usage info (`used: true` if at least one container references the image). Use this to see what portainer_prune_images would remove, or to spot old digests left behind by a rebuild-and-repush. Compact by design (id, tags, size, created, used) — no full/compact toggle needed.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
        })
        .strict(),
    },
    async ({ endpoint_id }) => asText(await p.listImages(endpoint_id)),
  );

  server.registerTool(
    "portainer_prune_images",
    {
      title: "Portainer: Prune Images",
      description:
        "Bulk-delete unused Docker images on an endpoint. Default removes only dangling/untagged images (Docker's own `docker image prune` default) — the leftovers once a rebuild-and-repush moves a tag to a new digest. Set all_unused=true to also remove tagged images not backing any container right now (like `docker image prune -a`) — reclaims more space but can delete an image kept around for rollback. Note: portainer_redeploy_stack, portainer_update_stack_file, portainer_redeploy_git_stack, and portainer_recreate_container already run the dangling-only version of this automatically after every call — reach for this tool for the all_unused case, or to clear backlog on an endpoint outside a redeploy.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          all_unused: z
            .boolean()
            .optional()
            .describe(
              "true = remove all unused images including tagged ones (docker image prune -a). false/omit = dangling/untagged only (safe default).",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge this bulk-deletes images",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, all_unused }) =>
      asText(
        await p.pruneImages(endpoint_id, { allUnused: all_unused ?? false }),
      ),
  );

  server.registerTool(
    "portainer_container_start",
    {
      title: "Portainer: Start Container",
      description:
        "Start a stopped container on a Docker endpoint. Pure passthrough to Docker's POST /containers/{id}/start.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id }) => {
      await p.containerStart(endpoint_id, container_id);
      return asText({
        ok: true,
        action: "start",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_stop",
    {
      title: "Portainer: Stop Container",
      description:
        "Stop a running container on a Docker endpoint. Sends SIGTERM and waits up to `timeout` seconds before SIGKILL (Docker default 10s if omitted).",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          timeout: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Seconds to wait for graceful SIGTERM before SIGKILL (Docker default 10s)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, timeout }) => {
      await p.containerStop(endpoint_id, container_id, timeout);
      return asText({
        ok: true,
        action: "stop",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_restart",
    {
      title: "Portainer: Restart Container",
      description:
        "Restart a container on a Docker endpoint. Sends SIGTERM, waits up to `timeout` seconds, SIGKILL, then start.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          timeout: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Seconds to wait for graceful SIGTERM before SIGKILL (Docker default 10s)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, timeout }) => {
      await p.containerRestart(endpoint_id, container_id, timeout);
      return asText({
        ok: true,
        action: "restart",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_kill",
    {
      title: "Portainer: Kill Container",
      description:
        "Send a signal (default SIGKILL) to a container. Skips graceful shutdown — small but real risk of corrupting state mid-write. Use restart/stop unless you specifically need to bypass the entrypoint's signal handlers.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          signal: z
            .string()
            .optional()
            .describe(
              "Signal to send (e.g. SIGKILL, SIGTERM, SIGUSR1). Docker default SIGKILL.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge skipping graceful shutdown",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, signal }) => {
      await p.containerKill(endpoint_id, container_id, signal);
      return asText({
        ok: true,
        action: "kill",
        endpoint_id,
        container_id,
        signal: signal ?? "SIGKILL",
      });
    },
  );

  server.registerTool(
    "portainer_container_delete",
    {
      title: "Portainer: Delete Container",
      description:
        "Delete a container. HIGH BLAST RADIUS AND IRREVERSIBLE — the container and its writable layer are gone. Anonymous (unnamed) volumes are removed only if remove_volumes=true; named volumes are never removed by this call. Docker refuses to delete a running container unless force=true, which kills it first (skipping graceful shutdown) then removes it. If the container belongs to a Portainer-managed stack, prefer portainer_delete_stack (or a redeploy) instead — deleting one container directly desyncs it from the stack record, and it may simply be recreated on the next redeploy.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          force: z
            .boolean()
            .optional()
            .describe(
              "Kill the container first if it's running (default false — Docker refuses to delete a running container otherwise)",
            ),
          remove_volumes: z
            .boolean()
            .optional()
            .describe(
              "Also remove anonymous volumes associated with the container (default false). Never removes named volumes.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the irreversible action",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, force, remove_volumes }) => {
      await p.containerDelete(endpoint_id, container_id, {
        force,
        removeVolumes: remove_volumes,
      });
      return asText({
        ok: true,
        action: "delete",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_redeploy_stack",
    {
      title: "Portainer: Redeploy Stack",
      description:
        "Redeploy a file-based Portainer stack (Compose or Swarm). Triggers a synchronous pull-and-recreate; the call may block for minutes on large stacks. Refuses git-managed stacks. NOTE: redeploying portainer-mcp's own stack will appear to fail because the in-flight HTTP fetch sees a connection drop mid-redeploy — the redeploy still succeeds in Portainer. After redeploying, automatically runs a dangling-only image prune on the stack's endpoint (see portainer_prune_images) and appends the result as `imagePrune` on the response — cleans up the digest the redeploy just superseded without a separate call. Also appends `containerChanges`: a before/after diff of the stack's containers by name, each marked recreated/unchanged/added/removed — a 200 response only means Portainer accepted the call, not that anything actually changed (e.g. a compose file with no matching env references would redeploy the exact same config every time). Omitted if the container list couldn't be read before or after. If `prune: true` was requested on a Compose-type stack, the response also carries `pruneWarning` — Portainer's Prune option only works for Swarm stacks and silently no-ops on Compose.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID to redeploy"),
          pull_image: z
            .boolean()
            .optional()
            .describe("Pull the latest image before recreating (default true)"),
          prune: z
            .boolean()
            .optional()
            .describe(
              "Remove containers for services no longer in the compose (default false). Swarm stacks only -- Portainer's own API restricts this to Swarm (Type 1); on a Compose stack (Type 2, the common case) it is silently ignored server-side, and the response carries a `pruneWarning` field when that happens. For Compose stacks, find and remove orphaned containers manually via portainer_list_containers + portainer_container_delete.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive action",
            ),
        })
        .strict(),
    },
    async ({ stack_id, pull_image, prune }) =>
      asText(
        await p.redeployStack(stack_id, {
          pullImage: pull_image ?? true,
          prune: prune ?? false,
        }),
      ),
  );

  server.registerTool(
    "portainer_update_stack_file",
    {
      title: "Portainer: Update Stack File",
      description:
        "Replace the compose YAML on a file-based Portainer stack (Compose or Swarm) and redeploy. Round-trips the existing stack-level Env so secrets aren't wiped. Sibling of portainer_redeploy_stack — that tool round-trips the existing file as-is; this one takes a new file. Refuses git-managed stacks (edit the repo + portainer_redeploy_git_stack instead) and non-Compose/Swarm types. Synchronous; may block for minutes on large stacks. Same self-redeploy caveat as portainer_redeploy_stack: redeploying portainer-mcp's own stack will appear to fail because the in-flight HTTP fetch sees a connection drop mid-redeploy — the redeploy still succeeds in Portainer. Same automatic post-redeploy image prune as portainer_redeploy_stack — see `imagePrune` on the response. Same `containerChanges` before/after container diff too (recreated/unchanged/added/removed per container name) — a 200 response doesn't by itself confirm anything actually changed. Same `pruneWarning` behavior as portainer_redeploy_stack when `prune: true` is requested on a Compose-type stack.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID to update"),
          compose_content: z
            .string()
            .min(1)
            .describe(
              "New compose YAML to install on the stack. Replaces the stored file in full — no diff/merge. Caller is responsible for round-tripping anything they want to keep. Portainer validates the YAML at deploy time; bad YAML surfaces as a deploy error.",
            ),
          pull_image: z
            .boolean()
            .optional()
            .describe("Pull the latest image before recreating (default true)"),
          prune: z
            .boolean()
            .optional()
            .describe(
              "Remove containers for services no longer in the compose (default false). Swarm stacks only -- Portainer's own API restricts this to Swarm (Type 1); on a Compose stack (Type 2, the common case) it is silently ignored server-side, and the response carries a `pruneWarning` field when that happens. For Compose stacks, find and remove orphaned containers manually via portainer_list_containers + portainer_container_delete.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive action",
            ),
        })
        .strict(),
    },
    async ({ stack_id, compose_content, pull_image, prune }) =>
      asText(
        await p.updateStackFile(stack_id, compose_content, {
          pullImage: pull_image ?? true,
          prune: prune ?? false,
        }),
      ),
  );

  server.registerTool(
    "portainer_redeploy_git_stack",
    {
      title: "Portainer: Redeploy Git Stack",
      description:
        "Redeploy a git-managed Portainer stack (Compose or Swarm). Pulls the latest commit from the stack's existing git ref, then redeploys. Round-trips the existing Env, ReferenceName, and git auth config so omitting them doesn't wipe them. Synchronous; may block for minutes on large stacks. Refuses non-git stacks (use portainer_redeploy_stack for those). After redeploying, automatically runs a dangling-only image prune on the stack's endpoint and appends the result as `imagePrune` on the response — the usual call after CI publishes a new image and you want the stack to pick it up. Also appends `containerChanges`: a before/after diff of the stack's containers by name (recreated/unchanged/added/removed) — confirms the pull actually landed rather than just that Portainer accepted the call. Same `pruneWarning` behavior as portainer_redeploy_stack when the effective prune value is true on a Compose-type stack.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID to redeploy"),
          pull_image: z
            .boolean()
            .optional()
            .describe("Pull the latest image before recreating (default true)"),
          prune: z
            .boolean()
            .optional()
            .describe(
              "Remove containers for services no longer in the compose. Default: preserve the stack's existing setting (false if never set). Swarm stacks only -- Portainer's own API restricts this to Swarm (Type 1); on a Compose stack (Type 2, the common case) it is silently ignored server-side, and the response carries a `pruneWarning` field when that happens. For Compose stacks, find and remove orphaned containers manually via portainer_list_containers + portainer_container_delete.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive action",
            ),
        })
        .strict(),
    },
    async ({ stack_id, pull_image, prune }) =>
      asText(
        await p.redeployGitStack(stack_id, {
          pullImage: pull_image ?? true,
          prune,
        }),
      ),
  );

  server.registerTool(
    "portainer_recreate_container",
    {
      title: "Portainer: Recreate Container",
      description:
        "Pull the image and recreate a single container, preserving its Config and HostConfig (env, mounts, networks, restart policy, etc). Cleaner than stack-redeploy for 'update one service after pushing a new image' workflows. The old container is stopped and removed; the new one keeps the same name and resource controls. Synchronous; the response is the new container's full inspect JSON plus an `imagePrune` field — recreate automatically runs a dangling-only image prune on the endpoint afterward, cleaning up the digest the recreate just superseded. TIMEOUT RISK: image pull + stop + remove + create all happen inline before this call returns, so a large image over a slow connection can take minutes and may exceed the calling MCP client's own tool-call timeout. If that happens, the recreate is NOT aborted server-side — it keeps running in Portainer regardless of whether the client gave up waiting. If this call appears to time out, verify the actual result with portainer_get_container rather than assuming it failed. For a large image, prefer calling portainer_pull_image first, then this tool with pull_image: false — the pull (slow, safe to retry) is decoupled from the recreate (fast, the actually destructive part), so a timeout can no longer land mid-recreate.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          pull_image: z
            .boolean()
            .optional()
            .describe("Pull the latest image before recreating (default true)"),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive action",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, pull_image }) =>
      asText(
        await p.recreateContainer(endpoint_id, container_id, {
          pullImage: pull_image ?? true,
        }),
      ),
  );

  server.registerTool(
    "portainer_pull_image",
    {
      title: "Portainer: Pull Image",
      description:
        'Pull a Docker image on an endpoint without touching any container. Use this before portainer_recreate_container(pull_image: false) when the image is large — splitting the slow pull off from the fast recreate avoids the MCP client\'s own tool-call timeout landing on the destructive half of the operation. A pull is safe to retry after a timeout: Docker caches already-downloaded layers, so a retry resumes rather than restarts from scratch (unlike a timed-out recreate, where a blind retry risks racing a second recreate against the one still running). Reports whether a new layer was actually downloaded (`status: "downloaded"`) or the image was already current (`status: "up-to-date"`) — a call returning at all doesn\'t by itself say which. No confirm gate: pulling only adds an image, it never removes or modifies anything running. Supports public/anonymous registries (Docker Hub, GHCR, etc.) only — it does not send any registry credential, so a private-registry pull fails with an auth error even if a matching credential is stored in Portainer (Settings > Registries). Adding that support is a well-scoped future enhancement (reference a stored credential by id, same pattern as create_git_stack\'s git_credential_id), not built here because the case that motivated this tool was a public-image pull.',
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          image: z
            .string()
            .min(1)
            .describe(
              'Image reference to pull, e.g. "nginx:1.27" or "ghcr.io/carldog/portainer-mcp:latest". Omitting a tag pulls "latest".',
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, image }) =>
      asText(await p.pullImage(endpoint_id, image)),
  );

  server.registerTool(
    "portainer_create_stack",
    {
      title: "Portainer: Create Stack",
      description:
        "Create a new file-based standalone Compose stack on a Docker endpoint. Pre-flight check refuses to create if a stack with the same name already exists on this endpoint (catches Portainer's silent same-name Swarm-stack deletion trap and prevents accidental overwrites — use portainer_redeploy_stack to update an existing stack, or portainer_delete_stack first if you really mean to recreate). Synchronous deploy; may block for minutes on large stacks. Returns the new stack JSON including its assigned ID.",
      inputSchema: z
        .object({
          name: z
            .string()
            .min(1)
            .describe(
              "Stack name. Lowercase recommended; must be unique on the endpoint.",
            ),
          endpoint_id: z
            .number()
            .int()
            .describe("Endpoint ID where the stack should be deployed"),
          compose: z
            .string()
            .min(1)
            .describe(
              "Full docker-compose.yml content as a string. Use ${VAR} references for any secrets and pass the values via env, not inlined in the YAML.",
            ),
          env: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
              }),
            )
            .optional()
            .describe(
              "Stack-level environment variables. Each becomes available for ${VAR} substitution in the compose file.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge creating a new stack",
            ),
        })
        .strict(),
    },
    async ({ name, endpoint_id, compose, env }) =>
      asText(
        await p.createStack(endpoint_id, {
          name,
          composeContent: compose,
          env,
        }),
      ),
  );

  server.registerTool(
    "portainer_create_git_stack",
    {
      title: "Portainer: Create Git-Managed Stack",
      description:
        "Create a new git-managed standalone Compose stack — Portainer clones the repo at the specified ref and deploys the compose file from inside it. Future redeploys via portainer_redeploy_git_stack will pull the latest commit. Pre-flight check refuses to create if a stack with the same name already exists on this endpoint. For a private repo, prefer git_credential_id (references an existing stored Portainer credential — nothing secret transits this call) over username/password. SECURITY NOTE: if you do pass username/password, the password (PAT/token) is sent in the tool call and may be visible in tool-call logs — use a scoped read-only PAT that's easy to rotate. git_credential_id and username/password are mutually exclusive.",
      inputSchema: z
        .object({
          name: z
            .string()
            .min(1)
            .describe("Stack name. Must be unique on the endpoint."),
          endpoint_id: z
            .number()
            .int()
            .describe("Endpoint ID where the stack should be deployed"),
          repository_url: z
            .string()
            .url()
            .describe(
              "Git repository URL (e.g. https://github.com/user/repo). HTTPS only — SSH not supported via this endpoint.",
            ),
          reference: z
            .string()
            .optional()
            .describe(
              "Git reference to deploy from (e.g. refs/heads/main, refs/tags/v1.0). Default: refs/heads/main.",
            ),
          compose_path: z
            .string()
            .optional()
            .describe(
              "Path to the compose file within the repo. Default: docker-compose.yml.",
            ),
          env: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
              }),
            )
            .optional()
            .describe(
              "Stack-level environment variables for ${VAR} substitution in the compose file.",
            ),
          username: z
            .string()
            .optional()
            .describe(
              "Git auth username (private repos only). For GitHub PAT auth, any non-empty value works (e.g. 'x-access-token').",
            ),
          password: z
            .string()
            .optional()
            .describe(
              "Git auth password / Personal Access Token (private repos only). Visible in tool-call logs — use a scoped read-only token. Mutually exclusive with git_credential_id.",
            ),
          git_credential_id: z
            .number()
            .int()
            .optional()
            .describe(
              "ID of an existing stored Portainer git credential (Settings > Git credentials in the Portainer UI) to use instead of username/password — nothing secret transits this call. Mutually exclusive with username/password.",
            ),
          auto_update_interval: z
            .string()
            .optional()
            .describe(
              'Enables Portainer\'s periodic git-poll auto-redeploy at this interval (Go duration string, e.g. "5m", "1h"). Omit to leave AutoUpdate disabled — the stack only redeploys when portainer_redeploy_git_stack is called.',
            ),
          force_pull_image: z
            .boolean()
            .optional()
            .describe(
              "With auto_update_interval set, also re-pull the image on every poll even if the git ref is unchanged (default false). Ignored if auto_update_interval is omitted.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge creating a new stack",
            ),
        })
        .strict(),
    },
    async ({
      name,
      endpoint_id,
      repository_url,
      reference,
      compose_path,
      env,
      username,
      password,
      git_credential_id,
      auto_update_interval,
      force_pull_image,
    }) =>
      asText(
        await p.createGitStack(endpoint_id, {
          name,
          repositoryUrl: repository_url,
          referenceName: reference,
          composePath: compose_path,
          env,
          username,
          password,
          gitCredentialId: git_credential_id,
          autoUpdateInterval: auto_update_interval,
          forcePullImage: force_pull_image,
        }),
      ),
  );

  server.registerTool(
    "portainer_convert_stack_to_git",
    {
      title: "Portainer: Convert File-Based Stack to Git-Managed",
      description:
        "Convert an existing file-based Compose/Swarm stack into a git-managed one in one atomic operation. Reads the source stack's real env (including secret values, server-side, never exposed to tool-call logs), deletes the source, then creates a new git-managed stack with the same name and endpoint, inheriting the env. Requires two-factor confirm: confirm: true AND confirm_name matching the source stack's actual Name. ATOMICITY RISK: the delete happens before the create. If the create fails (bad repo URL, malformed compose at HEAD, network issue, or — for a private repo — missing/invalid credentials) the source is gone and the error includes a recovery payload with the original compose YAML + the env key NAMES so you can rebuild via portainer_create_stack and re-add env values via the Portainer UI. For a private repo, prefer git_credential_id (references an existing stored Portainer credential) over username/password — both are validated up front, before the source stack is touched, so a bad combination refuses cleanly rather than deleting first. NEW STACK USES THE REPO'S COMPOSE — if the repo's docker-compose.yml differs from the source's (different ports, volumes, etc.), the new stack picks up the repo's values. SELF-CONVERSION WARNING: do not run this against the portainer-mcp stack itself — the call dies mid-flight when portainer-mcp is killed. This tool is the right, safer choice for every OTHER stack — prefer it over a manual delete-and-recreate through the UI, which silently drops any env var the operator forgets to retype.",
      inputSchema: z
        .object({
          source_stack_id: z
            .number()
            .int()
            .describe("ID of the existing file-based stack to convert"),
          repository_url: z
            .string()
            .url()
            .describe(
              "Git repository URL providing the new stack's compose (e.g. https://github.com/user/repo). HTTPS only.",
            ),
          reference: z
            .string()
            .optional()
            .describe(
              "Git reference to deploy from. Default: refs/heads/main.",
            ),
          compose_path: z
            .string()
            .optional()
            .describe(
              "Path to the compose file within the repo. Default: docker-compose.yml.",
            ),
          username: z
            .string()
            .optional()
            .describe(
              "Git auth username (private repos only). For GitHub PAT auth, any non-empty value works.",
            ),
          password: z
            .string()
            .optional()
            .describe(
              "Git auth password / PAT (private repos only). Visible in tool-call logs — use a scoped read-only token. Mutually exclusive with git_credential_id.",
            ),
          git_credential_id: z
            .number()
            .int()
            .optional()
            .describe(
              "ID of an existing stored Portainer git credential (Settings > Git credentials in the Portainer UI) to use instead of username/password — nothing secret transits this call. Mutually exclusive with username/password.",
            ),
          auto_update_interval: z
            .string()
            .optional()
            .describe(
              'Enables Portainer\'s periodic git-poll auto-redeploy at this interval (Go duration string, e.g. "5m", "1h") on the new stack. Omit to leave AutoUpdate disabled.',
            ),
          force_pull_image: z
            .boolean()
            .optional()
            .describe(
              "With auto_update_interval set, also re-pull the image on every poll even if the git ref is unchanged (default false). Ignored if auto_update_interval is omitted.",
            ),
          confirm_name: z
            .string()
            .min(1)
            .describe(
              "Must exactly match the source stack's Name. Two-factor confirm.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive (delete-then-create) operation",
            ),
        })
        .strict(),
    },
    async ({
      source_stack_id,
      repository_url,
      reference,
      compose_path,
      username,
      password,
      git_credential_id,
      auto_update_interval,
      force_pull_image,
      confirm_name,
    }) =>
      asText(
        await p.convertStackToGit(source_stack_id, {
          repositoryUrl: repository_url,
          referenceName: reference,
          composePath: compose_path,
          username,
          password,
          gitCredentialId: git_credential_id,
          autoUpdateInterval: auto_update_interval,
          forcePullImage: force_pull_image,
          confirmName: confirm_name,
        }),
      ),
  );

  server.registerTool(
    "portainer_set_git_auth",
    {
      title: "Portainer: Set / Remove Git Authentication on a Stack",
      description:
        "Add, update, or remove git authentication credentials on an existing git-managed stack — without triggering a redeploy. Use this BEFORE flipping a public source repo to private so subsequent deploys can clone it. Pass username + password to set credentials; pass remove: true to wipe existing credentials. Round-trips the stack's existing env (via noRedact) and AutoUpdate config to avoid Portainer's wipe traps on this endpoint. SECURITY NOTE: the password parameter (PAT / git password) is sent in the tool call and may be visible in tool-call logs — use a scoped read-only PAT that's easy to rotate. After setting auth, do a portainer_redeploy_git_stack to actually exercise the new credentials.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID"),
          username: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Git auth username. For GitHub PAT auth, any non-empty value works (e.g. 'x-access-token' or your GitHub login). Required unless remove=true.",
            ),
          password: z
            .string()
            .optional()
            .describe(
              "Git auth password / Personal Access Token. Visible in tool-call logs — use a scoped read-only token. Required unless remove=true.",
            ),
          remove: z
            .boolean()
            .optional()
            .describe(
              "If true, removes existing git authentication from the stack (wipes saved username + password server-side). When set, omit username and password.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge writing/clearing stored git credentials",
            ),
        })
        .strict(),
    },
    async ({ stack_id, username, password, remove }) => {
      if (remove === true) {
        if (username !== undefined || password !== undefined) {
          throw new Error(
            "set_git_auth: when remove=true, do not pass username or password.",
          );
        }
        return asText(await p.setGitAuth(stack_id, { remove: true }));
      }
      if (username === undefined || password === undefined) {
        throw new Error(
          "set_git_auth: both username and password are required (unless remove=true).",
        );
      }
      return asText(await p.setGitAuth(stack_id, { username, password }));
    },
  );

  server.registerTool(
    "portainer_set_stack_env",
    {
      title: "Portainer: Set / Remove Stack Env Variables",
      description:
        "Add, update, or remove env variables on an existing stack. Auto-detects file-based vs git-managed and routes to the matching update endpoint, preserving the rest of the env via the noRedact server-side round-trip. Triggers a synchronous redeploy because Portainer can't change container env without restart. `pull_image` (default false) controls only whether the Docker IMAGE is re-pulled — on a GIT-MANAGED stack it does NOT make the call independent of git: Portainer's underlying git-redeploy endpoint always re-pulls from the remote first regardless of this flag, so ANY env change on a git-managed stack requires live git connectivity and fails if the stack's stored git credential is broken (no workaround exists — see docs/PORTAINER-API.md). At least one of `set` or `remove` is required. If a `set` key isn't referenced anywhere in the compose file (no `${KEY}` or `$KEY`), the response includes an `envWarnings` array flagging it — Portainer will store the value, but nothing will read it until the compose file references it. The response also includes `containerChanges`: a before/after diff of the stack's containers by name (recreated/unchanged/added/removed) — a 200 response only means Portainer accepted the call, not that the running container actually changed. SECURITY NOTE: any value passed in `set` is visible in the tool-call log (including secret values like API tokens). For setting secrets, accept the trade-off (no other programmatic path) or set them via the Portainer UI.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID"),
          set: z
            .array(
              z.object({
                name: z.string().min(1),
                value: z.string(),
              }),
            )
            .optional()
            .describe(
              "Env entries to add or update. If a `name` already exists in the stack's env, the value is overwritten; otherwise it's appended.",
            ),
          remove: z
            .array(z.string().min(1))
            .optional()
            .describe(
              "Env variable names to remove from the stack. Names not present in the existing env are silently ignored.",
            ),
          pull_image: z
            .boolean()
            .optional()
            .describe(
              "Pull the latest image as part of the redeploy (default false). Controls the Docker image pull only — on a git-managed stack this does NOT skip the git fetch: Portainer's git-redeploy endpoint always re-pulls from the remote regardless of this flag, so it still requires live git connectivity either way.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge that containers will be restarted",
            ),
        })
        .strict(),
    },
    async ({ stack_id, set, remove, pull_image }) =>
      asText(
        await p.setStackEnv(stack_id, {
          set,
          remove,
          pullImage: pull_image,
        }),
      ),
  );

  server.registerTool(
    "portainer_delete_stack",
    {
      title: "Portainer: Delete Stack",
      description:
        "Delete a stack — removes the containers, the on-disk ProjectPath, and the Portainer ResourceControl record. HIGH BLAST RADIUS: requires both confirm:true AND confirm_name matching the stack's actual name (two-factor confirmation prevents 'wrong stack id' disasters where the LLM picked the wrong number). Endpoint ID is read from the stack record automatically.",
      inputSchema: z
        .object({
          stack_id: z.number().int().describe("Stack ID to delete"),
          confirm_name: z
            .string()
            .min(1)
            .describe(
              "Must exactly match the stack's Name. Two-factor confirm — proves the caller knows which stack they're killing.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the destructive action",
            ),
        })
        .strict(),
    },
    async ({ stack_id, confirm_name }) =>
      asText(await p.deleteStack(stack_id, confirm_name)),
  );
}
