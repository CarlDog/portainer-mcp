# Conventions

## MCP-specific (CRITICAL)

- **stdout is the MCP wire protocol.** Never `console.log` —
  it corrupts the transport. All logging goes to **stderr** via
  `console.error`. This applies to dependencies too.
- Tool names: `portainer_<verb_noun>` (e.g. `portainer_list_stacks`).
  Always snake_case.
- Tool inputs: validated with `zod` schemas. Use `.describe(...)` on
  every field — descriptions surface to the LLM caller.
- Tool outputs: a single text content block with JSON-stringified
  payload. Use the `asText()` helper from `./util.js`.
- Errors: thrown from `PortainerClient` propagate; the MCP SDK wraps them.
  Don't swallow errors silently. Error messages include the HTTP method,
  path, status, and a 200-char body slice for diagnosis (no auth headers).

## TypeScript

- ESM only (`"type": "module"`). Imports use `.js` extension even when
  importing `.ts` files (NodeNext convention).
- `strict: true` + `noUncheckedIndexedAccess: true`.
- No `any`. Use `unknown` and let the LLM consume the JSON payload.
- For `fetch` `dispatcher` option (undici Agent), TypeScript's stock
  `RequestInit` type doesn't have `dispatcher`. Use a local
  `FetchInitWithDispatcher extends RequestInit` interface and cast
  back to `RequestInit` at the `fetch()` call. Avoids `any`.

## TLS / self-signed certs

- Default to verifying TLS (secure default).
- Opt out via `PORTAINER_VERIFY_TLS=false` env var. Common for home setups
  using Portainer's self-signed cert on port 9443.
- Implementation: `undici.Agent({ connect: { rejectUnauthorized: false } })`
  passed as the per-request `dispatcher`. Surgical — doesn't affect
  other fetches (vs. `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`,
  which leaks across the whole process).

## Docker

- Multi-stage. Build stage installs full deps + tsc; runtime stage gets
  only `dist/`, pruned `node_modules`, and `package.json`.
- Runtime image runs as non-root user `mcp`. Don't add `USER root`.
- API key passed at `docker run` time via `-e PORTAINER_API_KEY`. Never
  bake into the image.

## Security

- Per global rules: never print API keys. Error messages from `request()`
  include status + body slice but exclude headers (where the API key lives).
- HTTP transport currently has **no MCP auth** — bind only to private
  networks. Note in CLAUDE.md / README.
- `.gitignore` excludes `*.pem`, `*.key`, `*.pfx`, `*.p12`, `.env`.
- Pre-commit hook runs gitleaks AND a PII pattern scan. Don't bypass
  with `--no-verify`.

## Git

- Local repo author is overridden to noreply (see `project_overview`).
- `git add <specific-files>`, not `git add .` or `git add -A`.
- Commit messages: imperative mood, short first line, body explaining
  *why* over *what*. End with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Write operations (deferred)

- All v1 tools are read-only. Write operations (deploy/redeploy/remove
  stack, container start/stop/restart) are higher blast-radius and
  deliberately deferred.
- When adding writes:
  1. Add a clear "destructive" or "modifying" note in the tool description
  2. Consider returning a dry-run result first if applicable
  3. Document blast radius in CLAUDE.md
