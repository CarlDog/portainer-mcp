import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import {
  compactStack,
  filterStacksByName,
  type PortainerClient,
} from "../portainer.js";

export function registerStackTools(
  server: McpServer,
  p: PortainerClient,
): void {
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
    "portainer_redeploy_stack",
    {
      title: "Portainer: Redeploy Stack",
      description:
        "Redeploy a file-based Portainer stack (Compose or Swarm). Triggers a synchronous pull-and-recreate; the call may block for minutes on large stacks. Refuses git-managed stacks. NOTE: redeploying portainer-mcp's own stack will appear to fail because the in-flight HTTP fetch sees a connection drop mid-redeploy — the redeploy still succeeds in Portainer. Does not prune images automatically: a dangling digest may be an intentional rollback point, so inspect with portainer_list_images and call confirm-gated portainer_prune_images separately when cleanup is wanted. Appends `containerChanges`: a before/after diff of the stack's containers by name, each marked recreated/unchanged/added/removed — a 200 response only means Portainer accepted the call, not that anything actually changed. Omitted if the container list couldn't be read before or after. If `prune: true` was requested on a Compose-type stack, the response also carries `pruneWarning` — Portainer's Prune option only works for Swarm stacks and silently no-ops on Compose.",
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
        "Replace the compose YAML on a file-based Portainer stack (Compose or Swarm) and redeploy. Round-trips the existing stack-level Env so secrets aren't wiped. Sibling of portainer_redeploy_stack — that tool round-trips the existing file as-is; this one takes a new file. Refuses git-managed stacks (edit the repo + portainer_redeploy_git_stack instead) and non-Compose/Swarm types. Synchronous; may block for minutes on large stacks. Same self-redeploy caveat as portainer_redeploy_stack: redeploying portainer-mcp's own stack will appear to fail because the in-flight HTTP fetch sees a connection drop mid-redeploy — the redeploy still succeeds in Portainer. Does not prune images automatically; inspect and explicitly call confirm-gated portainer_prune_images if cleanup is wanted. Includes the same `containerChanges` and `pruneWarning` behavior as portainer_redeploy_stack.",
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
        "Redeploy a git-managed Portainer stack (Compose or Swarm). Pulls the latest commit from the stack's existing git ref, then redeploys. Round-trips the existing Env, ReferenceName, and git auth config so omitting them doesn't wipe them. Synchronous; may block for minutes on large stacks. Refuses non-git stacks (use portainer_redeploy_stack for those). Does not prune images automatically: a dangling digest may be an intentional rollback point, so inspect with portainer_list_images and call confirm-gated portainer_prune_images separately when cleanup is wanted. Appends `containerChanges` and has the same `pruneWarning` behavior as portainer_redeploy_stack.",
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
              z
                .object({
                  name: z.string(),
                  value: z.string(),
                })
                .strict(),
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
              z
                .object({
                  name: z.string(),
                  value: z.string(),
                })
                .strict(),
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
        "Convert an existing file-based Compose/Swarm stack into a git-managed one. Reads the source stack's real env (including secret values, server-side, never exposed to tool-call logs), then performs a read-only repository-file preview that verifies the repo URL, ref, compose path, and credentials before any deletion. After that preflight passes, it deletes the source and creates a git-managed stack with the same name and endpoint, inheriting the env. Requires two-factor confirm: confirm: true AND confirm_name matching the source stack's actual Name. RESIDUAL ATOMICITY RISK: the delete still happens before the create. A malformed Compose file, bind/image/runtime deployment failure, or network race after the preview can leave the source gone; the error includes a recovery payload with the original compose YAML + env key NAMES so you can rebuild via portainer_create_stack and re-add env values via the Portainer UI. For a private repo, prefer git_credential_id (references an existing stored Portainer credential) over username/password. NEW STACK USES THE REPO'S COMPOSE — if the repo's docker-compose.yml differs from the source's (different ports, volumes, etc.), the new stack picks up the repo's values. SELF-CONVERSION WARNING: do not run this against the portainer-mcp stack itself — the call dies mid-flight when portainer-mcp is killed. This tool is the right, safer choice for every OTHER stack — prefer it over a manual delete-and-recreate through the UI, which silently drops any env var the operator forgets to retype.",
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
              z
                .object({
                  name: z.string().min(1),
                  value: z.string(),
                })
                .strict(),
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
