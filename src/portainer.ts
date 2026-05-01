import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Agent } from "undici";
import { z } from "zod";
import { asText } from "./util.js";

export interface PortainerConfig {
  url: string;
  apiKey: string;
  verifyTls: boolean;
}

interface FetchInitWithDispatcher extends RequestInit {
  dispatcher?: Agent;
}

const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|key$)/i;
const REDACTED = "<redacted>";

function scrubEnvArray(arr: unknown[]): unknown[] {
  return arr.map((entry) => {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const nameKey = "Name" in e ? "Name" : "name" in e ? "name" : null;
      const valueKey = "Value" in e ? "Value" : "value" in e ? "value" : null;
      if (
        nameKey &&
        valueKey &&
        typeof e[nameKey] === "string" &&
        SECRET_KEY_RE.test(e[nameKey] as string)
      ) {
        return { ...e, [valueKey]: REDACTED };
      }
      return entry;
    }
    if (typeof entry === "string") {
      const eq = entry.indexOf("=");
      if (eq > 0) {
        const key = entry.slice(0, eq);
        if (SECRET_KEY_RE.test(key)) {
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
      } else {
        obj[k] = redactSecrets(v);
      }
    }
    return obj;
  }
  return value;
}

export class PortainerClient {
  private readonly insecureDispatcher: Agent | undefined;

  constructor(private readonly config: PortainerConfig) {
    if (!config.verifyTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    opts?: { noRedact?: boolean },
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
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const init: FetchInitWithDispatcher = {
      method,
      headers,
      body: bodyStr,
    };
    if (this.insecureDispatcher) {
      init.dispatcher = this.insecureDispatcher;
    }
    const res = await fetch(url, init as RequestInit);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Portainer ${res.status} ${res.statusText} for ${method} ${path}: ${errBody.slice(0, 200)}`,
      );
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const data = (await res.json()) as unknown;
      return (opts?.noRedact ? data : redactSecrets(data)) as T;
    }
    return (await res.text()) as unknown as T;
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

  async getStack(id: number): Promise<unknown> {
    return this.request("GET", `/api/stacks/${id}`);
  }

  async listContainers(endpointId: number, all: boolean): Promise<unknown> {
    const query: Record<string, string> = {};
    if (all) query.all = "true";
    return this.request(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/json`,
      query,
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

  async containerLogs(
    endpointId: number,
    containerId: string,
    tail: number,
  ): Promise<string> {
    const query = {
      stdout: "true",
      stderr: "true",
      tail: String(tail),
      timestamps: "true",
    };
    return this.request<string>(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/logs`,
      query,
    );
  }

  async systemStatus(): Promise<unknown> {
    return this.request("GET", "/api/system/status");
  }

  async containerStart(
    endpointId: number,
    containerId: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/endpoints/${endpointId}/docker/containers/${containerId}/start`,
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

  async redeployStack(
    stackId: number,
    opts: { pullImage: boolean; prune: boolean },
  ): Promise<unknown> {
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
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; redeploy supports only Compose (2) and Swarm (1). Kubernetes stacks (3) require a different endpoint.`,
      );
    }
    const file = await this.request<{ StackFileContent: string }>(
      "GET",
      `/api/stacks/${stackId}/file`,
      undefined,
      undefined,
      { noRedact: true },
    );
    return this.request(
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
  }

  async redeployGitStack(
    stackId: number,
    opts: { pullImage: boolean; prune?: boolean },
  ): Promise<unknown> {
    interface RawAuth {
      Username?: string;
      AuthorizationType?: number;
    }
    interface RawGitConfig {
      ReferenceName?: string;
      Authentication?: RawAuth | null;
    }
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
    const auth = stack.GitConfig.Authentication;
    const payload: Record<string, unknown> = {
      // All four are unconditionally assigned by the handler — omitting wipes
      // them. Round-trip the existing values so a "redeploy as-is" call doesn't
      // silently destroy the stack's git/env config.
      repositoryReferenceName: stack.GitConfig.ReferenceName ?? "",
      env: stack.Env ?? [],
      repullImageAndRedeploy: opts.pullImage,
      prune: opts.prune ?? stack.Option?.Prune ?? false,
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
    return this.request(
      "PUT",
      `/api/stacks/${stackId}/git/redeploy`,
      { endpointId: String(stack.EndpointId) },
      payload,
    );
  }

  async recreateContainer(
    endpointId: number,
    containerId: string,
    opts: { pullImage: boolean },
  ): Promise<unknown> {
    // Note: this is a Portainer-NATIVE handler (not under the Docker proxy
    // tree). The path is `/api/docker/{id}/containers/{containerId}/recreate`,
    // NOT `/api/endpoints/{id}/docker/containers/{containerId}/recreate`. The
    // proxy tree at /api/endpoints/{id}/docker/ is for direct Docker API
    // passthroughs; recreate is a Portainer composition that pulls the
    // image, stops + removes the old container, and recreates with the
    // same Config + HostConfig.
    return this.request(
      "POST",
      `/api/docker/${endpointId}/containers/${containerId}/recreate`,
      undefined,
      { PullImage: opts.pullImage },
    );
  }

  async createStack(
    endpointId: number,
    spec: {
      name: string;
      composeContent: string;
      env?: Array<{ name: string; value: string }>;
    },
  ): Promise<unknown> {
    // Pre-flight name-collision check across all stacks on this endpoint.
    // Catches two failure modes:
    //   1. Portainer's silent-nuke trap on standalone/string create —
    //      checkAndCleanStackDupFromSwarm deletes any existing Swarm stack
    //      with the same name on the same endpoint without warning.
    //   2. Honest user error / LLM hallucinating a stack name that
    //      already exists. Either way, refusing here is safer than
    //      letting Portainer silently destroy state.
    interface RawStackSummary {
      Name: string;
      EndpointId: number;
    }
    const existing = await this.request<RawStackSummary[]>(
      "GET",
      "/api/stacks",
      { filters: JSON.stringify({ EndpointId: endpointId }) },
    );
    const collision = existing.find((s) => s.Name === spec.name);
    if (collision) {
      throw new Error(
        `Stack "${spec.name}" already exists on endpoint ${endpointId}. Refusing to create — use portainer_redeploy_stack to update an existing stack, or portainer_delete_stack first if you really want to recreate from scratch.`,
      );
    }
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

export function registerPortainerTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_endpoints",
    {
      title: "Portainer: List Endpoints",
      description:
        "List all Portainer environments (Docker hosts/Swarms registered with Portainer).",
      inputSchema: {},
    },
    async () => asText(await p.listEndpoints()),
  );

  server.registerTool(
    "portainer_list_stacks",
    {
      title: "Portainer: List Stacks",
      description:
        "List all stacks managed by Portainer, optionally filtered by endpoint.",
      inputSchema: {
        endpoint_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Optional endpoint ID to filter stacks to a single Docker host",
          ),
      },
    },
    async ({ endpoint_id }) => asText(await p.listStacks(endpoint_id)),
  );

  server.registerTool(
    "portainer_get_stack",
    {
      title: "Portainer: Get Stack",
      description:
        "Get full stack details (compose file content, env, status, git config) by stack ID.",
      inputSchema: {
        id: z.number().int().describe("Stack ID"),
      },
    },
    async ({ id }) => asText(await p.getStack(id)),
  );

  server.registerTool(
    "portainer_list_containers",
    {
      title: "Portainer: List Containers",
      description:
        "List containers in an endpoint. Set all=true to include stopped containers.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        all: z
          .boolean()
          .optional()
          .describe("Include stopped containers (default false)"),
      },
    },
    async ({ endpoint_id, all }) =>
      asText(await p.listContainers(endpoint_id, all ?? false)),
  );

  server.registerTool(
    "portainer_get_container",
    {
      title: "Portainer: Get Container",
      description:
        "Get container details (state, config, networks, mounts) by ID or name.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
      },
    },
    async ({ endpoint_id, container_id }) =>
      asText(await p.getContainer(endpoint_id, container_id)),
  );

  server.registerTool(
    "portainer_container_logs",
    {
      title: "Portainer: Container Logs",
      description:
        "Fetch the tail of a container's logs (raw output, may include Docker stream multiplexing prefixes for non-TTY containers).",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
        tail: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Number of log lines to return (default 100)"),
      },
    },
    async ({ endpoint_id, container_id, tail }) =>
      asText(await p.containerLogs(endpoint_id, container_id, tail ?? 100)),
  );

  server.registerTool(
    "portainer_system_status",
    {
      title: "Portainer: System Status",
      description: "Get Portainer version and system info.",
      inputSchema: {},
    },
    async () => asText(await p.systemStatus()),
  );

  server.registerTool(
    "portainer_container_start",
    {
      title: "Portainer: Start Container",
      description:
        "Start a stopped container on a Docker endpoint. Pure passthrough to Docker's POST /containers/{id}/start.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
      },
    },
    async ({ endpoint_id, container_id }) => {
      await p.containerStart(endpoint_id, container_id);
      return asText({
        ok: true,
        action: "start",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_stop",
    {
      title: "Portainer: Stop Container",
      description:
        "Stop a running container on a Docker endpoint. Sends SIGTERM and waits up to `timeout` seconds before SIGKILL (Docker default 10s if omitted).",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
        timeout: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Seconds to wait for graceful SIGTERM before SIGKILL (Docker default 10s)",
          ),
      },
    },
    async ({ endpoint_id, container_id, timeout }) => {
      await p.containerStop(endpoint_id, container_id, timeout);
      return asText({
        ok: true,
        action: "stop",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_restart",
    {
      title: "Portainer: Restart Container",
      description:
        "Restart a container on a Docker endpoint. Sends SIGTERM, waits up to `timeout` seconds, SIGKILL, then start.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
        timeout: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Seconds to wait for graceful SIGTERM before SIGKILL (Docker default 10s)",
          ),
      },
    },
    async ({ endpoint_id, container_id, timeout }) => {
      await p.containerRestart(endpoint_id, container_id, timeout);
      return asText({
        ok: true,
        action: "restart",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_container_kill",
    {
      title: "Portainer: Kill Container",
      description:
        "Send a signal (default SIGKILL) to a container. Skips graceful shutdown — small but real risk of corrupting state mid-write. Use restart/stop unless you specifically need to bypass the entrypoint's signal handlers.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
        signal: z
          .string()
          .optional()
          .describe(
            "Signal to send (e.g. SIGKILL, SIGTERM, SIGUSR1). Docker default SIGKILL.",
          ),
        confirm: z
          .literal(true)
          .describe(
            "Must be exactly true to acknowledge skipping graceful shutdown",
          ),
      },
    },
    async ({ endpoint_id, container_id, signal }) => {
      await p.containerKill(endpoint_id, container_id, signal);
      return asText({
        ok: true,
        action: "kill",
        endpoint_id,
        container_id,
        signal: signal ?? "SIGKILL",
      });
    },
  );

  server.registerTool(
    "portainer_redeploy_stack",
    {
      title: "Portainer: Redeploy Stack",
      description:
        "Redeploy a file-based Portainer stack (Compose or Swarm). Triggers a synchronous pull-and-recreate; the call may block for minutes on large stacks. Refuses git-managed stacks. NOTE: redeploying portainer-mcp's own stack will appear to fail because the in-flight HTTP fetch sees a connection drop mid-redeploy — the redeploy still succeeds in Portainer.",
      inputSchema: {
        stack_id: z.number().int().describe("Stack ID to redeploy"),
        pull_image: z
          .boolean()
          .optional()
          .describe("Pull the latest image before recreating (default true)"),
        prune: z
          .boolean()
          .optional()
          .describe(
            "Remove containers for services no longer in the compose (default false)",
          ),
        confirm: z
          .literal(true)
          .describe(
            "Must be exactly true to acknowledge the destructive action",
          ),
      },
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
    "portainer_redeploy_git_stack",
    {
      title: "Portainer: Redeploy Git Stack",
      description:
        "Redeploy a git-managed Portainer stack (Compose or Swarm). Pulls the latest commit from the stack's existing git ref, then redeploys. Round-trips the existing Env, ReferenceName, and git auth config so omitting them doesn't wipe them. Synchronous; may block for minutes on large stacks. Refuses non-git stacks (use portainer_redeploy_stack for those).",
      inputSchema: {
        stack_id: z.number().int().describe("Stack ID to redeploy"),
        pull_image: z
          .boolean()
          .optional()
          .describe("Pull the latest image before recreating (default true)"),
        prune: z
          .boolean()
          .optional()
          .describe(
            "Remove containers for services no longer in the compose. Default: preserve the stack's existing setting (false if never set).",
          ),
        confirm: z
          .literal(true)
          .describe(
            "Must be exactly true to acknowledge the destructive action",
          ),
      },
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
    "portainer_recreate_container",
    {
      title: "Portainer: Recreate Container",
      description:
        "Pull the image and recreate a single container, preserving its Config and HostConfig (env, mounts, networks, restart policy, etc). Cleaner than stack-redeploy for 'update one service after pushing a new image' workflows. The old container is stopped and removed; the new one keeps the same name and resource controls. Synchronous; the response is the new container's full inspect JSON.",
      inputSchema: {
        endpoint_id: z.number().int().describe("Endpoint ID"),
        container_id: z.string().describe("Container ID or name"),
        pull_image: z
          .boolean()
          .optional()
          .describe("Pull the latest image before recreating (default true)"),
        confirm: z
          .literal(true)
          .describe(
            "Must be exactly true to acknowledge the destructive action",
          ),
      },
    },
    async ({ endpoint_id, container_id, pull_image }) =>
      asText(
        await p.recreateContainer(endpoint_id, container_id, {
          pullImage: pull_image ?? true,
        }),
      ),
  );

  server.registerTool(
    "portainer_create_stack",
    {
      title: "Portainer: Create Stack",
      description:
        "Create a new file-based standalone Compose stack on a Docker endpoint. Pre-flight check refuses to create if a stack with the same name already exists on this endpoint (catches Portainer's silent same-name Swarm-stack deletion trap and prevents accidental overwrites — use portainer_redeploy_stack to update an existing stack, or portainer_delete_stack first if you really mean to recreate). Synchronous deploy; may block for minutes on large stacks. Returns the new stack JSON including its assigned ID.",
      inputSchema: {
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
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          )
          .optional()
          .describe(
            "Stack-level environment variables. Each becomes available for ${VAR} substitution in the compose file.",
          ),
        confirm: z
          .literal(true)
          .describe("Must be exactly true to acknowledge creating a new stack"),
      },
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
    "portainer_delete_stack",
    {
      title: "Portainer: Delete Stack",
      description:
        "Delete a stack — removes the containers, the on-disk ProjectPath, and the Portainer ResourceControl record. HIGH BLAST RADIUS: requires both confirm:true AND confirm_name matching the stack's actual name (two-factor confirmation prevents 'wrong stack id' disasters where the LLM picked the wrong number). Endpoint ID is read from the stack record automatically.",
      inputSchema: {
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
      },
    },
    async ({ stack_id, confirm_name }) =>
      asText(await p.deleteStack(stack_id, confirm_name)),
  );
}
