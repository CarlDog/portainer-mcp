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
      return (await res.json()) as T;
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
}
