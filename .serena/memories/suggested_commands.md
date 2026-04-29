# Suggested commands

Originally developed on Windows with bash (Git Bash) and PowerShell;
the commands below assume one of those shells. Forward slashes in
paths work in bash; backslashes in PowerShell.

## Node / build

```bash
npm install            # install deps
npm run typecheck      # tsc --noEmit
npm run build          # tsc → dist/
npm run dev            # tsx src/index.ts (needs PORTAINER_URL, PORTAINER_API_KEY)
npm run lint           # eslint .
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run start          # node dist/index.js
```

## Docker

```bash
docker build -t portainer-mcp .

# stdio (manual)
docker run -i --rm \
  -e PORTAINER_URL=https://nas.local:9443 \
  -e PORTAINER_API_KEY=ptr_... \
  -e PORTAINER_VERIFY_TLS=false \
  portainer-mcp

# HTTP via compose
docker compose up
```

## Git / GitHub

```bash
git status
git add <specific-files>      # don't use `git add .` per security rules
git commit -m "..."            # pre-commit: gitleaks + PII pattern scan
git push
gh repo view --web             # open repo in browser
```

The pre-commit hook is enabled via `git config core.hooksPath .githooks`
(already done in this repo). Requires `gitleaks` on PATH — install via
`winget install gitleaks` on Windows, `brew install gitleaks` on macOS,
or your distro's package manager on Linux.

## Smoke test (HTTP transport)

```bash
# Start server in HTTP mode (load .env, set MCP_PORT)
set -a; source .env; set +a
MCP_PORT=3004 npm run dev &
sleep 5

# Health check
curl -s http://localhost:3004/health

# MCP initialize → grab session id
INIT=$(curl -s -i -X POST http://localhost:3004/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}')
SID=$(echo "$INIT" | grep -i "^mcp-session-id" | sed 's/.*: *//' | tr -d '\r\n')

# Call a tool
curl -s -X POST http://localhost:3004/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"portainer_list_stacks","arguments":{}}}'
```

## Windows-specific notes (when applicable)

- On Windows, `bash` is Git Bash. Drive letters map as `/c/path` ↔ `C:\path`.
- Avoid `find`, `grep`, `cat`, `ls -R` for file ops — use the Glob/Grep/Read tools.
- Line endings: with autocrlf, working tree is CRLF on Windows and the
  repo stays LF. Shell scripts checked into the repo (e.g.
  `.githooks/pre-commit`) must keep LF endings to run on Linux/Docker.
- Killing background `npm run dev` on Windows: a `kill` of the npm shim
  may not propagate to the node child. Use the port-PID lookup pattern:
  ```bash
  PORT_PID=$(netstat -ano | awk '$2 ~ /:3004$/ && /LISTENING/ {print $NF}' | head -1)
  [ -n "$PORT_PID" ] && taskkill //F //PID $PORT_PID //T
  ```
