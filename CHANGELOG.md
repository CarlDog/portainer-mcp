# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The v0.6.0 entry is a backfill (standards UNI-12 / UNI-19) reconstructed from
git history and STATUS.md — this repo shipped to the NAS before it carried a
changelog, and `package.json` had already advanced to 0.6.0 without any tag or
release behind it. From here forward, update this file alongside the work
rather than after the fact.

## [Unreleased]

### Added

- Added `portainer_delete_volume`, closing a dogfooded cleanup gap without
  exposing Docker's broad volume-prune operation. The tool requires
  `confirm: true` plus an exact `confirm_name`, re-inspects the volume and
  verifies an exact match in Docker's current dangling list before deletion,
  never passes `force=true`, and therefore retains Docker's atomic final
  attachment check as a race-condition backstop.

## [0.8.3] - 2026-08-28

### Changed

- Bumped `express` 4.22.2 → 5.2.1 and `@types/express` 4.17.25 → 5.0.6,
  the third and final major from Dependabot PR #11 to be addressed
  (typescript remains deferred — see STATUS.md). Researched the real
  breaking changes before touching anything, then confirmed each one
  against this codebase's actual usage rather than assuming. Only one
  applied: Express 5's `app.listen()` wraps its callback with `once()`
  and registers it as the server's own `error` listener, so a bind
  failure (e.g. a stale container still holding the port during a
  Portainer manual recreate) now calls back with an `Error` instead of
  the Express 4 behavior of throwing it as an uncaught exception. Fixed
  in `src/index.ts`'s HTTP-transport `listen()` callback to check for
  and log the error, then `process.exit(1)` — without this fix, a port
  collision would have silently logged a false "listening" line while
  nothing was actually bound. Everything else researched and confirmed
  not applicable: path-to-regexp v8's stricter route syntax (this repo's
  only two routes, `/mcp` and `/health`, are literal strings with zero
  pattern syntax), removed/renamed methods, `req.query`/`req.body`
  default changes, `express.static()` changes, and the stricter
  `res.status()` range (already only ever called with fixed literal
  codes). Verified beyond typecheck/lint/test: manually started the
  built server, drove a full initialize handshake, `tools/list`, and a
  session-terminating `DELETE /mcp` (confirming the now-terminated
  session correctly 404s on reuse) against the real HTTP transport —
  none of this is covered by the existing test suite, which only
  exercises `src/shared/http-transport.ts` directly, never
  `src/index.ts`'s actual bootstrap. Most importantly, empirically
  proved the listen-callback fix: started a second instance on the
  same already-bound port and confirmed it now logs the bind failure
  and exits 1, instead of a false "listening" line. Also built and ran
  the real multi-stage Docker image in HTTP mode and sent it a genuine
  SIGTERM via `docker stop` — confirmed graceful shutdown and a clean
  `exitCode=0`, not a forced kill.

## [0.8.2] - 2026-08-28

### Changed

- Bumped `undici` 6.28.0 → 8.10.0, the second of three majors bundled in
  Dependabot PR #11 (after zod; express and typescript remain deferred —
  typescript specifically because `typescript-eslint` hard-blocks TS7
  today, see STATUS.md). Researched before touching anything: undici 8
  flips its `allowH2` default from `false` to `true`, so `PortainerClient`
  now always constructs an explicit `Agent` (not just for the insecure-TLS
  case) with `allowH2: false` pinned on both branches — this bump stays a
  pure version-currency move rather than an opportunistic behavior change,
  especially on the self-signed-cert dispatcher path that has real
  incident history (the node:22-alpine → node:26-alpine regression this
  file's own comments document). Also bumped `engines.node` to
  `>=22.19.0` to match undici 8's actual floor (Docker image and CI both
  already clear it — documentation accuracy, not a functional change).
  `Dispatcher.HttpMethod`'s type shape is unchanged for this codebase's
  usage. Added `test/tls-dispatcher.test.ts`: a real self-signed TLS
  server (generated at runtime via the new `selfsigned` devDependency,
  nothing committed) proving the dispatcher is genuinely honored
  end-to-end — the existing `test/transport.test.ts` is source-level only
  and structurally cannot catch "the new undici major changed how the
  Agent options map onto an actual TLS handshake." Verified with a full
  `docker build` (multi-stage; `selfsigned` correctly pruned from the
  runtime image by the existing `npm prune --omit=dev` step) and a
  container smoke test.

## [0.8.1] - 2026-08-28

### Changed

- Bumped `zod` 3.25.76 → 4.5.1. Dependabot PR #11 had bundled this with
  three unrelated majors (express 5, undici 8, typescript 7) that carry
  real, unverified breaking-change risk for this repo's Express-based
  HTTP transport and version-sensitive `undici` dispatcher usage — done
  as a scoped manual bump instead of merging that PR wholesale. The
  "zod 4 blocked on the MCP SDK" reasoning that closed the predecessor
  PR (#9) no longer holds: `@modelcontextprotocol/sdk` (installed:
  1.30.0) has declared `"zod": "^3.25 || ^4.0"` since ≥1.28.0, and ships
  a dedicated runtime-detecting compat shim
  (`zod-json-schema-compat.js`) that routes v3 schemas through the
  vendored `zod-to-json-schema` converter and v4 schemas through zod's
  own native `toJSONSchema`. Verified via a real MCP client/server
  round-trip, not just `tsc`: all 31 tools' advertised JSON schemas are
  unchanged (`additionalProperties: false` at every level including
  nested env-array items, `required` arrays, enums, min/max), and
  runtime request validation still rejects an unrecognized key and a
  missing `confirm: true` with the same clear error shape. No source
  changes needed — this codebase's zod usage (`z.object`, `.strict()`,
  `z.string()`, `z.number().int()`, `z.literal()`, `z.enum()`,
  `z.array()`, `.optional()`, `.describe()`, `.min()`/`.max()`) sits
  entirely within the unchanged-behavior subset of the v3→v4 migration.
  express/undici/typescript remain on their current majors — see
  STATUS.md "Next" for that decision.

## [0.8.0] - 2026-08-28

Same-day follow-up to 0.7.0: closes the remaining known gaps left open by
that pass, then a phase-end-audit-triggered internal refactor. Tool count
30 → 31.

### Added

- `portainer_pull_image` — pull an image on an endpoint without touching any
  container. Splits the slow part of `portainer_recreate_container`'s
  pull-then-recreate off from the fast, destructive part, so a large image
  no longer risks the MCP client's own tool-call timeout landing mid-recreate.
  Public/anonymous registries only for now.
- `since` / `until` params on `portainer_container_logs`, accepting a Unix
  timestamp, an RFC3339 datetime, or a relative duration (`"10m"`, `"1h30m"`)
  — mirrors `docker logs --since`'s own convention.
- `containerChanges` field on `portainer_redeploy_stack`,
  `portainer_update_stack_file`, `portainer_redeploy_git_stack`, and
  `portainer_set_stack_env` — a before/after diff of the stack's containers
  by name (`recreated`/`unchanged`/`added`/`removed`), so a 200 response
  distinguishes "Portainer accepted the call" from "something actually
  changed."
- `pruneWarning` field on `portainer_redeploy_stack`, `portainer_update_stack_file`,
  and `portainer_redeploy_git_stack` — fires when `prune: true` is requested
  against a Compose-type stack, where Portainer's `Prune` option silently has
  no effect (it's Swarm-only per Portainer's own API).
- `SECURITY.md` — vulnerability disclosure policy.

### Changed

- Internal: all 31 MCP tool registrations moved from a single
  `src/portainer.ts` into `src/tools/{stacks,containers,images,networks,volumes,system}.ts`,
  one file per Portainer resource. `src/portainer.ts` now holds only
  `PortainerClient`, the shared pure helper functions, and a thin
  orchestrator. No user-facing behavior change. See CLAUDE.md's "Tool
  registration layout."
- Internal: deduplicated the response-merge helpers (`withImagePrune`,
  `withContainerChanges`, `withEnvWarnings`, `withPruneWarning`) onto a
  single shared `mergeField` implementation; deduplicated the stack-name
  pre-flight collision check shared by `createStack`/`createGitStack`; and
  the git-redeploy payload construction shared by `redeployGitStack`/
  `setStackEnv`'s git-managed branch. No behavior change — closes several
  self-acknowledged duplication spots found during a phase-end audit, each
  guarding a real correctness/security rule (Portainer's silent same-name
  Swarm-stack deletion, and the git-config-wipe trap on stack updates).

## [0.7.0] - 2026-08-28

Dogfooding backlog: closes 7 accumulated `mcp-feedback` OpenChronicle
memories in one pass. Tool count 26 → 30.

### Added

- `portainer_container_delete` — delete a container (confirm-gated, mirrors
  `portainer_container_kill`'s pattern).
- `portainer_list_networks` / `portainer_inspect_network` /
  `portainer_prune_networks` — network read + prune tools mirroring the
  existing volume tools. Network pruning is lower-risk than the still-unbuilt
  volume prune: an unused network holds no data, so it's confirm-gated but
  built.
- `include_file` param on `portainer_get_stack` (default `true`) — the tool
  now actually returns `StackFileContent`, which its own description always
  promised but the implementation never fetched. Fails soft with a
  `StackFileError` field rather than silently omitting it.
- `auto_update_interval` / `force_pull_image` params on
  `portainer_create_git_stack` and `portainer_convert_stack_to_git` — enable
  Portainer's periodic git-poll auto-redeploy at creation time instead of a
  manual Portainer UI edit afterward. Registry-credential wiring isn't
  available on this Portainer endpoint at all (confirmed against the pinned
  Swagger spec) — image-pull-poll only.
- `envWarnings` on `portainer_set_stack_env`'s response — flags any `set` key
  that isn't referenced anywhere in the compose file (`${KEY}`/`$KEY`), which
  is otherwise a silent no-op: Portainer stores the value, nothing reads it.

### Changed

- **Package renamed to `@carldog/portainer-mcp`.** The unscoped name
  `portainer-mcp` was still free, but three fleet repos had already lost
  theirs to unrelated packages; a scope is reserved to the account, so no
  name inside it can be taken. Nothing is published to npm - this ships as a
  container - so the rename is invisible to consumers; `package-lock.json`
  was regenerated with it.
- **`package.json` is now `private: true`.** It makes the config honest
  (there is no publish workflow and no `NPM_TOKEN`) and makes an accidental
  `npm publish` fail instead of succeeding.
- **All 30 tool schemas now enforce `.strict()`.** An unknown or misspelled
  input key is rejected with a clear "unrecognized key" error instead of
  being silently dropped and surfacing as a confusing "required field
  missing" error instead.
- `portainer_get_stack`'s `id` param renamed to `stack_id`, matching every
  other stack tool.
- `portainer_list_endpoints`, `portainer_list_stacks`, and
  `portainer_get_container` are compact-by-default now, mirroring
  `portainer_list_containers`'s existing convention; `full=true` opts into
  the raw objects. `portainer_list_stacks` also gained a client-side `name`
  substring filter (Portainer's `/stacks` endpoint has no server-side name
  filter).
- `portainer_container_logs` returns clean, newline-delimited text — Docker's
  stream-multiplexing frame headers are now stripped server-side (demuxed
  against the raw response bytes, not an already-decoded string, so payloads
  ≥128 bytes demux correctly) instead of leaking into the response.
- Error messages from failed Portainer calls now include up to 2000 chars of
  the upstream error body (was 200) — the old cap silently truncated the one
  detail needed to diagnose a failure.
- `portainer_recreate_container`'s description now documents that a
  client-side tool-call timeout does not abort the recreate server-side.

## [0.6.0] - 2026-08-28

First tagged release. Deployed and verified on the NAS, serving live stack
data over the Streamable HTTP transport.

### Added

- Read tools across the Portainer surface: endpoints, stacks, containers,
  images, volumes, plus `portainer_container_logs` and
  `portainer_system_status`.
- Stack write tools — `portainer_create_stack`, `portainer_delete_stack`,
  `portainer_update_stack_file`, `portainer_set_stack_env`,
  `portainer_redeploy_stack`, `portainer_create_git_stack`,
  `portainer_redeploy_git_stack`, `portainer_convert_stack_to_git`, and
  `portainer_set_git_auth` (closing the public-to-private repo gap).
- Container lifecycle tools — `portainer_container_start` / `_stop` /
  `_restart` / `_kill`, and `portainer_recreate_container`.
- Server `instructions` field, so the MCP describes itself to clients on
  initialize.
- HTTP transport hardening: a Host/Origin allowlist (`MCP_ALLOWED_HOSTS`) as
  the primary DNS-rebinding defense (binding `0.0.0.0` is not itself a
  control inside a container), optional bearer auth (`MCP_AUTH_TOKEN`) as a
  second layer, and idle-session eviction (`MCP_SESSION_IDLE_MS`) via a
  periodic sweep — via a new `src/shared/http-transport.ts` ported from the
  fleet's canonical MCP-F03 template.

### Changed

- **The reported server version is now derived from `package.json`**
  (`src/shared/version.ts` + `test/version-sync.test.ts`, fleet standard
  MCP-T03). It had drifted: the manifest read 0.6.0 while `src/index.ts`
  hardcoded `"0.1.0"`, so the MCP initialize response told every client 0.1.0
  across five minor versions. The two literals are now one const with a test
  asserting they match.
- `flavor: latest=false` on the publish workflow, so a release tag publishes
  `X.Y.Z` and `X.Y` without republishing `:latest` (UNI-19).

### Fixed

- Secret env values are redacted in Portainer responses, with a greppable
  `noRedact` opt-out for internal round-trips that must not write a
  placeholder back over a real value.
- `portainer_recreate_container` resolves a ref to its canonical ID first.
- Bodyless POSTs send an empty-JSON body rather than omitting it — the actual
  cause of a 400 on container start.
- A custom undici dispatcher now reaches global `fetch` (MCP-F07): a
  base-image bump had left the server unable to reach a self-signed Portainer
  while its own `/health` stayed green.
- Transport failures surface their real cause instead of Node's bare
  `TypeError: fetch failed` (MCP-F08).
- An unknown/expired HTTP session id now returns the spec-required 404
  instead of a blanket 400 (2025-06-18 Session Management §3/§4) — the old
  400 read as a generic protocol error and left clients wedged until a human
  restarted them.
