# Codebase structure

```
portainer-mcp/
├── src/
│   ├── index.ts        # MCP server entry — env, transport selection, createServer factory
│   ├── portainer.ts    # PortainerClient (X-API-Key + optional insecure dispatcher) + tool registrations
│   └── util.ts         # asText() helper
├── dist/               # tsc output — gitignored
├── .githooks/
│   └── pre-commit      # gitleaks + PII pattern scan
├── .github/workflows/
│   ├── docker-publish.yml  # multi-arch GHCR build on main + tags
│   └── test.yml            # cross-OS typecheck/build matrix + lint/format quality job
├── .vscode/                # workspace settings, extensions, launch, tasks
├── Dockerfile              # multi-stage: build → runtime (alpine, non-root)
├── docker-compose.yml      # HTTP transport, port 3004:3000, env passthrough
├── eslint.config.js        # ESLint 9 flat config
├── .prettierrc.json
├── .prettierignore
├── package.json            # type: module, ESM
├── tsconfig.json           # strict + noUncheckedIndexedAccess
├── portainer-mcp.code-workspace
├── CLAUDE.md
├── STATUS.md               # single source of truth for project status
└── README.md
```

**Tools registered** (all read-only, 7 total):

| Tool | Description |
| --- | --- |
| `portainer_list_endpoints` | List Docker hosts |
| `portainer_list_stacks` | Stacks (optionally filtered by endpoint) |
| `portainer_get_stack` | Stack details by ID |
| `portainer_list_containers` | Containers in an endpoint |
| `portainer_get_container` | Container details by ID/name |
| `portainer_container_logs` | Tail of container logs |
| `portainer_system_status` | Portainer version + system info |

**Adding a tool:**
1. Add a method to `PortainerClient` in `src/portainer.ts`
2. Add a `server.registerTool(...)` call in the same file's
   `registerPortainerTools` function
3. Use `zod` for input schema; wrap the result with `asText()`

**Trigger to introduce `src/tools/` directory:** the first tool that
orchestrates across multiple Portainer resources or does non-trivial
composition (e.g. "redeploy all stale-image stacks"). Don't pre-split.
