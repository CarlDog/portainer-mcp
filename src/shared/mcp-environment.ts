import { isIP } from "node:net";

export const DEFAULT_ALLOWED_HOSTS =
  "localhost,127.0.0.1,[::1],host.docker.internal";
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function configurationError(
  name: string,
  value: string,
  expectation: string,
): Error {
  return new Error(
    `${name}=${JSON.stringify(value)} is invalid; expected ${expectation}`,
  );
}

export function parsePositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw configurationError(name, value, "a positive decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw configurationError(
      name,
      value,
      `an integer from 1 through ${maximum}`,
    );
  }
  return parsed;
}

export function parseOptionalPort(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  return parsePositiveInteger("MCP_PORT", value, 0, 65_535);
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase() || "info";
  if (!(LOG_LEVELS as readonly string[]).includes(normalized)) {
    throw configurationError("LOG_LEVEL", value ?? "", LOG_LEVELS.join(", "));
  }
  return normalized as LogLevel;
}

export function normalizeAllowedHost(input: string): string {
  let value = input.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.endsWith(".") && isIP(value) === 0) value = value.slice(0, -1);
  if (value.length === 0 || /[\s/@?#*]/.test(value) || value.includes("://")) {
    throw configurationError(
      "MCP_ALLOWED_HOSTS",
      input,
      "a bare DNS hostname or IP literal",
    );
  }
  if (isIP(value) !== 0) return value;
  if (value.length > 253 || value.includes(":")) {
    throw configurationError(
      "MCP_ALLOWED_HOSTS",
      input,
      "a bare DNS hostname or IP literal",
    );
  }
  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw configurationError(
      "MCP_ALLOWED_HOSTS",
      input,
      "a bare DNS hostname or IP literal",
    );
  }
  return value;
}

export function parseAllowedHosts(value: string | undefined): string[] {
  const source = value?.trim() || DEFAULT_ALLOWED_HOSTS;
  const entries = source.split(",");
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw configurationError(
      "MCP_ALLOWED_HOSTS",
      source,
      "a comma-separated list without empty entries",
    );
  }
  return [...new Set(entries.map(normalizeAllowedHost))];
}

export function parseBindHost(value: string | undefined): string {
  const source = value?.trim() || "127.0.0.1";
  if (source.startsWith("[") || source.endsWith("]")) {
    throw configurationError(
      "MCP_BIND_HOST",
      source,
      "a bare DNS hostname or IP literal",
    );
  }
  try {
    return normalizeAllowedHost(source);
  } catch {
    throw configurationError(
      "MCP_BIND_HOST",
      source,
      "a bare DNS hostname or IP literal",
    );
  }
}

function hostnameFromAuthority(authority: string): string | undefined {
  const value = authority.trim();
  if (value.length === 0 || /[\s/@?#]/.test(value)) return undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return undefined;
    const suffix = value.slice(close + 1);
    if (suffix !== "" && !/^:[0-9]+$/.test(suffix)) return undefined;
    try {
      return normalizeAllowedHost(value.slice(0, close + 1));
    } catch {
      return undefined;
    }
  }
  const colons = [...value].filter((character) => character === ":").length;
  if (colons > 1) return undefined;
  const hostname =
    colons === 1 ? value.slice(0, value.lastIndexOf(":")) : value;
  const port =
    colons === 1 ? value.slice(value.lastIndexOf(":") + 1) : undefined;
  if (port !== undefined && !/^[0-9]+$/.test(port)) return undefined;
  try {
    return normalizeAllowedHost(hostname);
  } catch {
    return undefined;
  }
}

export interface RequestAuthority {
  host?: string;
  origin?: string;
}

export function requestAuthorityAllowed(
  headers: RequestAuthority,
  allowedHosts: readonly string[],
): boolean {
  if (allowedHosts.length === 0 || headers.host === undefined) return false;
  const allowed = new Set(allowedHosts.map(normalizeAllowedHost));
  const host = hostnameFromAuthority(headers.host);
  if (host === undefined || !allowed.has(host)) return false;
  if (headers.origin === undefined) return true;
  try {
    const origin = new URL(headers.origin);
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username !== "" ||
      origin.password !== ""
    )
      return false;
    return allowed.has(normalizeAllowedHost(origin.hostname));
  } catch {
    return false;
  }
}
