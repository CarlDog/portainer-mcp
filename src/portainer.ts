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
}
