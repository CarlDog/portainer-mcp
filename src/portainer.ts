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
    containerRef: string,
    opts: { pullImage: boolean },
  ): Promise<unknown> {
    // Note: this is a Portainer-NATIVE handler (not under the Docker proxy
    // tree). The path is `/api/docker/{id}/containers/{containerId}/recreate`,
    // NOT `/api/endpoints/{id}/docker/containers/{containerId}/recreate`. The
    // proxy tree at /api/endpoints/{id}/docker/ is for direct Docker API
    // passthroughs; recreate is a Portainer composition that pulls the
    // image, stops + removes the old container, and recreates with the
    // same Config + HostConfig.
    //
    // Inspect-first to resolve the caller's ref (name, short ID, or full ID)
    // to the canonical 64-char Docker ID. The recreate flow internally
    // disconnects the old container from its networks; that disconnect call
    // requires the full ID and 500s with a misleading "endpoint not found"
    // when given anything else. See PORTAINER-API.md gotcha
    // "POST /containers/{id}/recreate requires the full container ID".
    const resolved = await this.request<{ Id: string }>(
      "GET",
      `/api/endpoints/${endpointId}/docker/containers/${containerRef}/json`,
    );
    return this.request(
      "POST",
      `/api/docker/${endpointId}/containers/${resolved.Id}/recreate`,
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

  async createGitStack(
    endpointId: number,
    spec: {
      name: string;
      repositoryUrl: string;
      referenceName?: string;
      composePath?: string;
      env?: Array<{ name: string; value: string }>;
      username?: string;
      password?: string;
    },
  ): Promise<unknown> {
    // Same pre-flight name-collision check as createStack — refuse if any
    // stack on this endpoint already shares the name. Catches the silent
    // Swarm-stack nuke trap and prevents accidental overwrites.
    interface RawStackSummary {
      Name: string;
      EndpointId: number;
    }
    const existing = await this.request<RawStackSummary[]>(
      "GET",
      "/api/stacks",
      { filters: JSON.stringify({ EndpointId: endpointId }) },
    );
    if (existing.find((s) => s.Name === spec.name)) {
      throw new Error(
        `Stack "${spec.name}" already exists on endpoint ${endpointId}. Refusing to create — use portainer_redeploy_git_stack to update an existing git stack, or portainer_delete_stack first if you really want to recreate from scratch.`,
      );
    }
    const body: Record<string, unknown> = {
      Name: spec.name,
      RepositoryURL: spec.repositoryUrl,
      RepositoryReferenceName: spec.referenceName ?? "refs/heads/main",
      ComposeFile: spec.composePath ?? "docker-compose.yml",
      Env: spec.env ?? [],
    };
    // Only set the auth fields if either credential was provided. Public
    // repos don't need them; passing empty strings would still flip
    // RepositoryAuthentication=true and could confuse Portainer's
    // internal credential resolution.
    if (spec.username !== undefined || spec.password !== undefined) {
      body.RepositoryAuthentication = true;
      body.RepositoryUsername = spec.username ?? "";
      body.RepositoryPassword = spec.password ?? "";
    }
    return this.request(
      "POST",
      "/api/stacks/create/standalone/repository",
      { endpointId: String(endpointId) },
      body,
    );
  }

  async convertStackToGit(
    sourceStackId: number,
    spec: {
      repositoryUrl: string;
      referenceName?: string;
      composePath?: string;
      username?: string;
      password?: string;
      confirmName: string;
    },
  ): Promise<unknown> {
    interface RawEnvEntry {
      name?: string;
      Name?: string;
      value?: string;
      Value?: string;
    }
    interface RawStack {
      Id: number;
      Type: number;
      EndpointId: number;
      Name: string;
      Env?: RawEnvEntry[];
      GitConfig?: unknown;
    }
    // Step 1: Fetch source with raw env (noRedact) so we can carry the
    // real secret values into the new stack's env without ever exposing
    // them to the MCP caller.
    const source = await this.request<RawStack>(
      "GET",
      `/api/stacks/${sourceStackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (source.GitConfig != null) {
      throw new Error(
        `Stack ${sourceStackId} (${source.Name}) is already git-managed. Use portainer_redeploy_git_stack to update it instead.`,
      );
    }
    if (source.Type !== 1 && source.Type !== 2) {
      throw new Error(
        `Stack ${sourceStackId} (${source.Name}) has Type ${source.Type}; convert supports only Compose (2) and Swarm (1).`,
      );
    }
    // Two-factor confirm: caller must spell the source stack's name.
    if (source.Name !== spec.confirmName) {
      throw new Error(
        `Name mismatch: stack ${sourceStackId} is "${source.Name}", caller supplied confirm_name="${spec.confirmName}". Refusing to convert. Re-call with the correct name.`,
      );
    }
    // Capture the source compose content for a recovery payload if the
    // create step fails after delete. Best-effort — proceed if it fails.
    let composeContent = "";
    try {
      const file = await this.request<{ StackFileContent: string }>(
        "GET",
        `/api/stacks/${sourceStackId}/file`,
        undefined,
        undefined,
        { noRedact: true },
      );
      composeContent = file.StackFileContent;
    } catch {
      // Recovery payload will lack compose content; tolerable.
    }
    // Snapshot what we need before delete.
    const sourceName = source.Name;
    const sourceEndpoint = source.EndpointId;
    const sourceEnv: Array<{ name: string; value: string }> = (
      source.Env ?? []
    ).map((e) => ({
      name: (e.name ?? e.Name ?? "") as string,
      value: (e.value ?? e.Value ?? "") as string,
    }));
    // Step 2: Delete source. This frees the name so we can create the
    // new git-managed stack with the same Name (preserving any external
    // references like Claude Desktop's MCP config that targets the
    // stack's published port).
    await this.request("DELETE", `/api/stacks/${sourceStackId}`, {
      endpointId: String(sourceEndpoint),
    });
    // Step 3: Create the git-managed replacement with the captured env.
    try {
      return await this.createGitStack(sourceEndpoint, {
        name: sourceName,
        repositoryUrl: spec.repositoryUrl,
        referenceName: spec.referenceName,
        composePath: spec.composePath,
        env: sourceEnv,
        username: spec.username,
        password: spec.password,
      });
    } catch (createErr) {
      // Recovery payload — env keys only (NEVER values; we don't want
      // secrets landing in tool-call logs even on the failure path).
      // Compose content is included so the user can recreate the
      // file-based stack manually via portainer_create_stack and re-add
      // the env values via the Portainer UI.
      const envKeys = sourceEnv.map((e) => e.name).join(", ");
      const origMsg =
        createErr instanceof Error ? createErr.message : String(createErr);
      throw new Error(
        `Conversion failed AFTER source stack was deleted. The source stack "${sourceName}" (id ${sourceStackId}) on endpoint ${sourceEndpoint} no longer exists. To recover: re-run portainer_create_stack with name="${sourceName}", endpoint_id=${sourceEndpoint}, the compose YAML below, then re-add the env vars [${envKeys}] via the Portainer UI (their values are NOT included in this message — they remain protected). Original create error: ${origMsg}\n\n--- ORIGINAL COMPOSE YAML ---\n${composeContent}\n--- END COMPOSE YAML ---`,
      );
    }
  }

  async setStackEnv(
    stackId: number,
    changes: {
      set?: Array<{ name: string; value: string }>;
      remove?: string[];
      pullImage?: boolean;
    },
  ): Promise<unknown> {
    const setCount = changes.set?.length ?? 0;
    const removeCount = changes.remove?.length ?? 0;
    if (setCount === 0 && removeCount === 0) {
      throw new Error(
        "set_stack_env requires at least one entry in `set` or `remove`. Refusing no-op call.",
      );
    }
    interface RawEnvEntry {
      name?: string;
      Name?: string;
      value?: string;
      Value?: string;
    }
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
      Env?: RawEnvEntry[];
      GitConfig?: RawGitConfig | null;
      Option?: { Prune?: boolean } | null;
    }
    // Fetch the stack with raw env so we can read existing secret values
    // and merge the caller's changes without clobbering them.
    const stack = await this.request<RawStack>(
      "GET",
      `/api/stacks/${stackId}`,
      undefined,
      undefined,
      { noRedact: true },
    );
    if (stack.Type !== 1 && stack.Type !== 2) {
      throw new Error(
        `Stack ${stackId} (${stack.Name}) has Type ${stack.Type}; set_stack_env supports only Compose (2) and Swarm (1).`,
      );
    }
    // Normalize current env to lowercase {name, value} (Portainer returns
    // lowercase for /stacks endpoints — see scrubEnvArray for the same
    // dual-case handling).
    const currentEnv: Array<{ name: string; value: string }> = (
      stack.Env ?? []
    ).map((e) => ({
      name: (e.name ?? e.Name ?? "") as string,
      value: (e.value ?? e.Value ?? "") as string,
    }));
    // Apply remove first.
    const removeSet = new Set(changes.remove ?? []);
    const newEnv = currentEnv.filter((e) => !removeSet.has(e.name));
    // Apply set (upsert — overwrite by name, otherwise append).
    for (const entry of changes.set ?? []) {
      const idx = newEnv.findIndex((e) => e.name === entry.name);
      if (idx >= 0) {
        newEnv[idx] = entry;
      } else {
        newEnv.push(entry);
      }
    }
    // Detect file-based vs git-managed and route to the matching update
    // endpoint. Both trigger a synchronous redeploy because Portainer
    // can't change container env without restart, but neither pulls a
    // new image unless pullImage is true (env-only intent default).
    if (stack.GitConfig != null) {
      const auth = stack.GitConfig.Authentication;
      const payload: Record<string, unknown> = {
        // Round-trip the git config wipe-trap fields per
        // PORTAINER-API.md "Env round-trip" gotcha.
        repositoryReferenceName: stack.GitConfig.ReferenceName ?? "",
        env: newEnv,
        repullImageAndRedeploy: changes.pullImage ?? false,
        prune: stack.Option?.Prune ?? false,
        repositoryAuthentication: auth != null,
      };
      if (auth != null) {
        payload.repositoryUsername = auth.Username ?? "";
        // Empty password — Portainer reuses saved password if existing
        // GitConfig.Authentication is set.
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
    // File-based path: need to also round-trip the compose content.
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
        env: newEnv,
        repullImageAndRedeploy: changes.pullImage ?? false,
        prune: false,
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
    "portainer_create_git_stack",
    {
      title: "Portainer: Create Git-Managed Stack",
      description:
        "Create a new git-managed standalone Compose stack — Portainer clones the repo at the specified ref and deploys the compose file from inside it. Future redeploys via portainer_redeploy_git_stack will pull the latest commit. Pre-flight check refuses to create if a stack with the same name already exists on this endpoint. SECURITY NOTE: the password parameter (PAT/token for private repos) is sent in the tool call and may be visible in tool-call logs — use a scoped read-only PAT that's easy to rotate.",
      inputSchema: {
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
            z.object({
              name: z.string(),
              value: z.string(),
            }),
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
            "Git auth password / Personal Access Token (private repos only). Visible in tool-call logs — use a scoped read-only token.",
          ),
        confirm: z
          .literal(true)
          .describe("Must be exactly true to acknowledge creating a new stack"),
      },
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
        }),
      ),
  );

  server.registerTool(
    "portainer_convert_stack_to_git",
    {
      title: "Portainer: Convert File-Based Stack to Git-Managed",
      description:
        "Convert an existing file-based Compose/Swarm stack into a git-managed one in one atomic operation. Reads the source stack's real env (including secret values, server-side, never exposed to tool-call logs), deletes the source, then creates a new git-managed stack with the same name and endpoint, inheriting the env. Requires two-factor confirm: confirm: true AND confirm_name matching the source stack's actual Name. ATOMICITY RISK: the delete happens before the create. If the create fails (bad repo URL, malformed compose at HEAD, network issue), the source is gone and the error includes a recovery payload with the original compose YAML + the env key NAMES so you can rebuild via portainer_create_stack and re-add env values via the Portainer UI. NEW STACK USES THE REPO'S COMPOSE — if the repo's docker-compose.yml differs from the source's (different ports, volumes, etc.), the new stack picks up the repo's values. SELF-CONVERSION WARNING: do not run this against the portainer-mcp stack itself — the call dies mid-flight when portainer-mcp is killed.",
      inputSchema: {
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
          .describe("Git reference to deploy from. Default: refs/heads/main."),
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
            "Git auth password / PAT (private repos only). Visible in tool-call logs — use a scoped read-only token.",
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
      },
    },
    async ({
      source_stack_id,
      repository_url,
      reference,
      compose_path,
      username,
      password,
      confirm_name,
    }) =>
      asText(
        await p.convertStackToGit(source_stack_id, {
          repositoryUrl: repository_url,
          referenceName: reference,
          composePath: compose_path,
          username,
          password,
          confirmName: confirm_name,
        }),
      ),
  );

  server.registerTool(
    "portainer_set_stack_env",
    {
      title: "Portainer: Set / Remove Stack Env Variables",
      description:
        "Add, update, or remove env variables on an existing stack. Auto-detects file-based vs git-managed and routes to the matching update endpoint, preserving the rest of the env via the noRedact server-side round-trip. Triggers a synchronous redeploy because Portainer can't change container env without restart, but does NOT pull a new image by default (env-only intent — set pull_image=true to also pull). At least one of `set` or `remove` is required. SECURITY NOTE: any value passed in `set` is visible in the tool-call log (including secret values like API tokens). For setting secrets, accept the trade-off (no other programmatic path) or set them via the Portainer UI.",
      inputSchema: {
        stack_id: z.number().int().describe("Stack ID"),
        set: z
          .array(
            z.object({
              name: z.string().min(1),
              value: z.string(),
            }),
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
            "Pull the latest image as part of the redeploy (default false — env-only intent). Set true if you want to combine an env change with an image refresh.",
          ),
        confirm: z
          .literal(true)
          .describe(
            "Must be exactly true to acknowledge that containers will be restarted",
          ),
      },
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
