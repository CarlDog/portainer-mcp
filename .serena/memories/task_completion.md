# Task completion checklist

Before marking a code-touching task done:

1. **Typecheck:** `npm run typecheck` (must be clean)
2. **Lint:** `npm run lint` (must be clean)
3. **Format check:** `npm run format:check` (must be clean) or run
   `npm run format` to auto-fix
4. **Build:** `npm run build` (must succeed)
5. **Tests:** none yet — when added, run them here
6. **Manual verification (when relevant):**
   - For tool changes: run `npm run dev` against a real Portainer
     instance, exercise via the smoke test pattern in
     `suggested_commands` memory.
   - For Dockerfile changes: `docker build -t portainer-mcp .` and
     confirm `docker run` produces a clean handshake.
7. **STATUS.md:** update in the same commit as the work if the change
   advances or alters project state. Don't batch status updates.
8. **Commit:** the pre-commit hook runs gitleaks + PII pattern scan
   automatically. If either fails, fix the underlying issue —
   never bypass with `--no-verify`.

## Don't

- Don't run `npm install` to "fix" build issues without understanding
  what changed.
- Don't introduce mocks for Portainer in tests. Use a real instance
  behind env-gated tests (per global working-style on mock/prod divergence).
- Don't lower the test bar to make code pass. Fix the code, not the test.
- Don't commit with the global git identity — verify
  `git config user.email` shows the noreply address before committing.
- Don't add a write tool (deploy/restart/etc.) in the same commit as
  unrelated work. Write tools are higher blast-radius and warrant
  their own focused commit.
- Don't widen the API key's scope without need. Read-only tools work
  with read-only API keys (Portainer supports limited-scope keys).
