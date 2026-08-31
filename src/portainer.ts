import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import { registerSystemTools } from "./tools/system.js";
import { registerVolumeTools } from "./tools/volumes.js";
import { registerNetworkTools } from "./tools/networks.js";
import { registerImageTools } from "./tools/images.js";
import { registerContainerTools } from "./tools/containers.js";
import { registerStackTools } from "./tools/stacks.js";

interface PortainerConfig {
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

interface ContainerListOptions {
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

interface ImagePruneOptions {
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

// Shared by every with*() response-merge helper below: spread `value` onto
// `result` under `key` when `result` is a plain object (the common case --
// Portainer's write endpoints return the updated Stack/Container JSON), or
// wrap it when `result` isn't a plain object (defensive fallback in case a
// response shape ever turns out not to be one).
function mergeField(result: unknown, key: string, value: unknown): unknown {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), [key]: value };
  }
  return { result, [key]: value };
}

interface ContainerIdentity {
  name: string;
  id: string;
}

interface ContainerChange {
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
// using the same additive pattern as the other response helpers. `null` for
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
  return mergeField(result, "containerChanges", containerChanges);
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
// without clobbering it.
export function withEnvWarnings(result: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return result;
  return mergeField(result, "envWarnings", warnings);
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
// it -- same additive pattern as withEnvWarnings.
export function withPruneWarning(
  result: unknown,
  warning: string | null,
): unknown {
  if (warning === null) return result;
  return mergeField(result, "pruneWarning", warning);
}

interface EnvSideRaw {
  found: boolean;
  value: string;
}

interface EnvSideResult {
  found: boolean;
  empty: boolean;
}

interface CompareEnvValuesResult {
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

export interface FilteredDockerLogs {
  logs: string;
  lines_scanned: number;
  lines_matched: number;
  truncated: boolean;
}

export interface DockerLogFilterOptions {
  contains?: string;
  regex?: string;
  ignoreCase?: boolean;
  maxMatches?: number;
}

const LOG_FILTER_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const LOG_FILTER_MAX_PATTERN_LENGTH = 256;
const LOG_FILTER_MAX_MATCHES = 1000;
const LOG_FILTER_DEFAULT_MATCHES = 200;
const LOG_REGEX_TIMEOUT_MS = 250;

const REGEX_LOG_FILTER_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
try {
  const expression = new RegExp(
    workerData.pattern,
    workerData.ignoreCase ? "iu" : "u",
  );
  const selected = [];
  let linesMatched = 0;
  for (const line of workerData.lines) {
    if (expression.test(line)) {
      linesMatched += 1;
      if (selected.length < workerData.maxMatches) selected.push(line);
    }
  }
  parentPort.postMessage({
    ok: true,
    result: {
      logs: selected.length === 0 ? "" : selected.join("\n") + "\n",
      lines_scanned: workerData.lines.length,
      lines_matched: linesMatched,
      truncated: linesMatched > selected.length,
    },
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

function dockerLogLines(logs: string): string[] {
  if (logs === "") return [];
  const withoutTrailingNewline = logs.endsWith("\n") ? logs.slice(0, -1) : logs;
  return withoutTrailingNewline
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function filteredLogResult(
  lines: string[],
  matches: string[],
  linesMatched: number,
): FilteredDockerLogs {
  return {
    logs: matches.length === 0 ? "" : `${matches.join("\n")}\n`,
    lines_scanned: lines.length,
    lines_matched: linesMatched,
    truncated: linesMatched > matches.length,
  };
}

export async function filterDockerLogs(
  logs: string,
  options: DockerLogFilterOptions,
): Promise<FilteredDockerLogs> {
  const filterCount =
    Number(options.contains !== undefined) +
    Number(options.regex !== undefined);
  if (filterCount !== 1) {
    throw new Error("Specify exactly one of contains or regex");
  }
  const pattern = options.contains ?? options.regex ?? "";
  if (pattern.length === 0 || pattern.length > LOG_FILTER_MAX_PATTERN_LENGTH) {
    throw new Error(
      `Log filter must be 1-${LOG_FILTER_MAX_PATTERN_LENGTH} characters`,
    );
  }
  const maxMatches = options.maxMatches ?? LOG_FILTER_DEFAULT_MATCHES;
  if (
    !Number.isSafeInteger(maxMatches) ||
    maxMatches < 1 ||
    maxMatches > LOG_FILTER_MAX_MATCHES
  ) {
    throw new Error(
      `max_matches must be an integer from 1-${LOG_FILTER_MAX_MATCHES}`,
    );
  }
  if (Buffer.byteLength(logs, "utf8") > LOG_FILTER_MAX_INPUT_BYTES) {
    throw new Error(
      "Fetched logs exceed the 2 MiB filtering cap; narrow tail, since, or until and retry",
    );
  }

  const lines = dockerLogLines(logs);
  if (options.contains !== undefined) {
    const needle = options.ignoreCase
      ? options.contains.toLowerCase()
      : options.contains;
    const matches: string[] = [];
    let linesMatched = 0;
    for (const line of lines) {
      const candidate = options.ignoreCase ? line.toLowerCase() : line;
      if (candidate.includes(needle)) {
        linesMatched += 1;
        if (matches.length < maxMatches) matches.push(line);
      }
    }
    return filteredLogResult(lines, matches, linesMatched);
  }

  try {
    new RegExp(pattern, options.ignoreCase ? "iu" : "u");
  } catch (error) {
    throw new Error(
      `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return new Promise<FilteredDockerLogs>((resolve, reject) => {
    const worker = new Worker(REGEX_LOG_FILTER_WORKER_SOURCE, {
      eval: true,
      workerData: {
        lines,
        pattern,
        ignoreCase: options.ignoreCase ?? false,
        maxMatches,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(
        new Error(
          `Regex filter exceeded ${LOG_REGEX_TIMEOUT_MS}ms and was terminated; use a simpler regex or contains`,
        ),
      );
    }, LOG_REGEX_TIMEOUT_MS);

    worker.once("message", (message: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (
        message === null ||
        typeof message !== "object" ||
        !("ok" in message) ||
        message.ok !== true ||
        !("result" in message)
      ) {
        const detail =
          message !== null &&
          typeof message === "object" &&
          "error" in message &&
          typeof message.error === "string"
            ? message.error
            : "invalid worker response";
        reject(new Error(`Regex filter failed: ${detail}`));
        return;
      }
      resolve(message.result as FilteredDockerLogs);
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Regex filter worker failed: ${error.message}`));
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Regex filter worker exited with code ${code}`));
    });
  });
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

interface PullProgressResult {
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

// Shapes of a raw (noRedact) GET /api/stacks/{id} response's git-auth and
// env sub-structures. Read identically by several PortainerClient methods
// that each need their own round-trip of the same fields to avoid
// Portainer's wipe-trap endpoints (see docs/PORTAINER-API.md "Env
// round-trip is required" and "Git stacks vs file stacks"). RawGitConfig
// includes TLSSkipVerify even though only setGitAuth reads it -- callers
// that don't need it simply don't reference the field, and a superset type
// here is safe since every caller narrows via optional chaining.
interface RawAuth {
  Username?: string;
  AuthorizationType?: number;
}
interface RawGitConfig {
  ReferenceName?: string;
  TLSSkipVerify?: boolean;
  Authentication?: RawAuth | null;
}
// Portainer's /stacks endpoints return env entries in lowercase
// ({name, value}), but this dual-case shape guards against either casing
// -- see scrubEnvArray for the same rule applied to the redactor's own env
// scan. Carries a real correctness rule (which casing key exists) that
// must stay in sync everywhere it's read.
interface RawEnvEntry {
  name?: string;
  Name?: string;
  value?: string;
  Value?: string;
}

export function encodeRegistryAuth(registryId: number): string {
  if (!Number.isSafeInteger(registryId) || registryId <= 0) {
    throw new Error("registry_id must be a positive safe integer");
  }
  return Buffer.from(JSON.stringify({ registryId }), "utf8").toString("base64");
}

export class PortainerClient {
  // Always constructed (not just for the insecure-TLS case) so every request
  // goes through an explicit Agent rather than falling through to undici's
  // implicit global default. allowH2 is pinned false on both branches:
  // undici 8 flipped its own default from false to true, and this repo has
  // zero operational data on how HTTP/2 negotiates against a home-lab
  // Portainer/Docker-proxy deployment (possibly sitting behind a reverse
  // proxy) -- the undici 6->8 bump stays a pure version-currency move, not
  // an opportunistic behavior change, especially on the self-signed-cert
  // path this Agent has real incident history on (see the request() comment
  // below).
  private readonly dispatcher: Agent;

  constructor(private readonly config: PortainerConfig) {
    this.dispatcher = new Agent(
      config.verifyTls
        ? { allowH2: false }
        : { allowH2: false, connect: { rejectUnauthorized: false } },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    opts?: {
      noRedact?: boolean;
      raw?: boolean;
      additionalHeaders?: Record<string, string>;
    },
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
    if (opts?.additionalHeaders) {
      Object.assign(headers, opts.additionalHeaders);
    }
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
    init.dispatcher = this.dispatcher;
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
  ): Promise<EnvSideRaw> {
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
    opts: {
      since?: string;
      until?: string;
      contains?: string;
      regex?: string;
      ignoreCase?: boolean;
      maxMatches?: number;
    } = {},
  ): Promise<string | FilteredDockerLogs> {
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
    const logs = demuxDockerLogs(raw);
    if (opts.contains === undefined && opts.regex === undefined) return logs;
    return filterDockerLogs(logs, opts);
  }

  // Pulls an image without touching any container -- splits the slow part
  // of a recreate-with-pull off from the fast part, so a large image no
  // longer risks blowing the MCP client's own tool-call timeout on a
  // destructive recreate call. See portainer_recreate_container's
  // description for the paired usage.
  async pullImage(
    endpointId: number,
    image: string,
    registryId?: number,
  ): Promise<PullProgressResult> {
    const raw = await this.request<Buffer>(
      "POST",
      `/api/endpoints/${endpointId}/docker/images/create`,
      { fromImage: image },
      undefined,
      {
        raw: true,
        additionalHeaders:
          registryId === undefined
            ? undefined
            : { "X-Registry-Auth": encodeRegistryAuth(registryId) },
      },
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

  async deleteVolume(
    endpointId: number,
    volumeName: string,
    confirmName: string,
  ): Promise<unknown> {
    const inspected = await this.inspectVolume(endpointId, volumeName);
    const dangling = await this.listVolumes(endpointId, {
      dangling: true,
      name: volumeName,
    });
    assertVolumeDeletionSafe(volumeName, confirmName, inspected, dangling);

    // Never pass force=true. Docker rechecks attachment state atomically at
    // deletion time and returns a conflict if a container attached after our
    // dangling snapshot, closing the check/delete race without data loss.
    await this.request(
      "DELETE",
      `/api/endpoints/${endpointId}/docker/volumes/${encodeURIComponent(volumeName)}`,
    );
    return {
      ok: true,
      action: "delete",
      volume_name: volumeName,
      endpoint_id: endpointId,
    };
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
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(result, pruneNoopWarning(stack.Type, opts.prune)),
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
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(result, pruneNoopWarning(stack.Type, opts.prune)),
      before,
      after,
    );
  }

  // Shared by redeployGitStack and setStackEnv's git-managed branch: both
  // PUT to /api/stacks/{id}/git/redeploy, and the handler unconditionally
  // overwrites repositoryReferenceName/env/repullImageAndRedeploy/prune/
  // repositoryAuthentication (+username/password/authorizationType when
  // auth exists) -- see docs/PORTAINER-API.md "Env round-trip is required".
  // Omitting any of these wipes them, so every caller of this endpoint must
  // round-trip the same fields; callers pass their own resolved env/prune
  // since redeployGitStack lets the caller override the stored prune value
  // while setStackEnv always preserves it.
  private buildGitRedeployPayload(
    gitConfig: RawGitConfig,
    env: unknown[],
    opts: { pullImage: boolean; prune: boolean },
  ): Record<string, unknown> {
    const auth = gitConfig.Authentication;
    const payload: Record<string, unknown> = {
      repositoryReferenceName: gitConfig.ReferenceName ?? "",
      env,
      repullImageAndRedeploy: opts.pullImage,
      prune: opts.prune,
      repositoryAuthentication: auth != null,
    };
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
    return payload;
  }

  async redeployGitStack(
    stackId: number,
    opts: { pullImage: boolean; prune?: boolean },
  ): Promise<unknown> {
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
    const effectivePrune = opts.prune ?? stack.Option?.Prune ?? false;
    const payload = this.buildGitRedeployPayload(
      stack.GitConfig,
      stack.Env ?? [],
      { pullImage: opts.pullImage, prune: effectivePrune },
    );
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
    const after = await this.trySnapshotStackContainers(
      stack.EndpointId,
      stack.Name,
    );
    return withContainerChanges(
      withPruneWarning(result, pruneNoopWarning(stack.Type, effectivePrune)),
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
    return this.request(
      "POST",
      `/api/docker/${endpointId}/containers/${resolved.Id}/recreate`,
      undefined,
      { PullImage: opts.pullImage },
    );
  }

  // Shared pre-flight name-collision check for createStack/createGitStack —
  // refuses if any stack on this endpoint already has this name. Catches two
  // failure modes:
  //   1. Portainer's silent-nuke trap on standalone/string create —
  //      checkAndCleanStackDupFromSwarm deletes any existing Swarm stack
  //      with the same name on the same endpoint without warning.
  //   2. Honest user error / LLM hallucinating a stack name that
  //      already exists. Either way, refusing here is safer than
  //      letting Portainer silently destroy state.
  // `redeployToolName` is the tool to suggest instead in the error message —
  // the two callers have different redeploy tools for an existing stack.
  private async assertNoStackNameCollision(
    endpointId: number,
    name: string,
    redeployToolName: string,
  ): Promise<void> {
    interface RawStackSummary {
      Name: string;
      EndpointId: number;
    }
    const existing = await this.request<RawStackSummary[]>(
      "GET",
      "/api/stacks",
      { filters: JSON.stringify({ EndpointId: endpointId }) },
    );
    if (existing.find((s) => s.Name === name)) {
      throw new Error(
        `Stack "${name}" already exists on endpoint ${endpointId}. Refusing to create — use ${redeployToolName} to update an existing stack, or portainer_delete_stack first if you really want to recreate from scratch.`,
      );
    }
  }

  async createStack(
    endpointId: number,
    spec: {
      name: string;
      composeContent: string;
      env?: Array<{ name: string; value: string }>;
    },
  ): Promise<unknown> {
    await this.assertNoStackNameCollision(
      endpointId,
      spec.name,
      "portainer_redeploy_stack",
    );
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
    await this.assertNoStackNameCollision(
      endpointId,
      spec.name,
      "portainer_redeploy_git_stack",
    );
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

  private async assertGitRepositoryFileReachable(
    sourceName: string,
    spec: {
      repositoryUrl: string;
      referenceName?: string;
      composePath?: string;
      username?: string;
      password?: string;
      gitCredentialId?: number;
    },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      repository: spec.repositoryUrl,
      reference: spec.referenceName ?? "refs/heads/main",
      targetFile: spec.composePath ?? "docker-compose.yml",
      TLSSkipVerify: false,
    };
    if (spec.gitCredentialId !== undefined) {
      // Live-verified against Portainer 2.39.7: the preview endpoint uses
      // lower-camel gitCredentialID, unlike create-stack's PascalCase
      // RepositoryGitCredentialID field.
      body.authorizationType = 0;
      body.gitCredentialID = spec.gitCredentialId;
    } else if (spec.username !== undefined || spec.password !== undefined) {
      body.authorizationType = 0;
      body.username = spec.username ?? "";
      body.password = spec.password ?? "";
    }

    try {
      await this.request(
        "POST",
        "/api/gitops/repo/file/preview",
        undefined,
        body,
      );
    } catch (previewErr) {
      const message =
        previewErr instanceof Error ? previewErr.message : String(previewErr);
      throw new Error(
        `Git repository preflight failed before stack "${sourceName}" was changed: ${message}`,
        { cause: previewErr },
      );
    }
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
    // Prove the repository, ref, target compose path, and credentials work
    // while the source stack still exists. This does not validate Compose
    // semantics and cannot eliminate a later network race, but it closes the
    // known delete-first outage path for bad repository inputs.
    await this.assertGitRepositoryFileReachable(source.Name, spec);
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
      const payload = this.buildGitRedeployPayload(stack.GitConfig, newEnv, {
        pullImage: changes.pullImage ?? false,
        prune: stack.Option?.Prune ?? false,
      });
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

export function assertVolumeDeletionSafe(
  volumeName: string,
  confirmName: string,
  inspectedValue: unknown,
  danglingValue: unknown,
): void {
  if (
    typeof inspectedValue !== "object" ||
    inspectedValue === null ||
    Array.isArray(inspectedValue) ||
    typeof (inspectedValue as Record<string, unknown>).Name !== "string"
  ) {
    throw new Error(
      "Portainer returned a malformed volume inspection; refusing to delete",
    );
  }
  const inspectedName = (inspectedValue as { Name: string }).Name;
  if (inspectedName !== volumeName) {
    throw new Error(
      `Requested volume "${volumeName}" resolved to "${inspectedName}"; refusing to delete`,
    );
  }
  if (inspectedName !== confirmName) {
    throw new Error(
      `Name mismatch: volume is "${inspectedName}", caller supplied confirm_name="${confirmName}". Refusing to delete.`,
    );
  }
  if (
    typeof danglingValue !== "object" ||
    danglingValue === null ||
    Array.isArray(danglingValue) ||
    !Array.isArray((danglingValue as Record<string, unknown>).Volumes)
  ) {
    throw new Error(
      "Portainer returned a malformed dangling-volume list; refusing to delete",
    );
  }
  const isExactlyDangling = (
    danglingValue as { Volumes: unknown[] }
  ).Volumes.some(
    (volume) =>
      typeof volume === "object" &&
      volume !== null &&
      !Array.isArray(volume) &&
      (volume as Record<string, unknown>).Name === inspectedName,
  );
  if (!isExactlyDangling) {
    throw new Error(
      `Volume "${inspectedName}" is not currently dangling (unused). It may be attached to a container or its state may have changed; refusing to delete.`,
    );
  }
}

export function registerPortainerTools(
  server: McpServer,
  p: PortainerClient,
): void {
  registerSystemTools(server, p);
  registerVolumeTools(server, p);
  registerNetworkTools(server, p);
  registerImageTools(server, p);
  registerContainerTools(server, p);

  registerStackTools(server, p);
}
