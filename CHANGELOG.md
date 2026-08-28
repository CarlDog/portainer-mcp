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
