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
