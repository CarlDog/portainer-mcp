import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import {
  compactContainer,
  compactContainerInspect,
  type PortainerClient,
} from "../portainer.js";

export function registerContainerTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_containers",
    {
      title: "Portainer: List Containers",
      description:
        "List containers in an endpoint (compact projection by default; set full=true for complete Docker JSON). Filter by name substring, label, or status. Set all=true to include stopped containers.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          all: z
            .boolean()
            .optional()
            .describe("Include stopped containers (default false)"),
          name: z
            .string()
            .optional()
            .describe("Filter: container name substring"),
          label: z
            .string()
            .optional()
            .describe(
              'Filter: label "key" or "key=value" — e.g. "com.docker.compose.project=myapp" lists a stack\'s containers',
            ),
          status: z
            .enum([
              "created",
              "restarting",
              "running",
              "removing",
              "paused",
              "exited",
              "dead",
            ])
            .optional()
            .describe("Filter by container status (implies all=true)"),
          full: z
            .boolean()
            .optional()
            .describe(
              "Return complete Docker JSON per container (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, all, name, label, status, full }) => {
      const result = await p.listContainers(endpoint_id, {
        all,
        name,
        label,
        status,
      });
      if (full || !Array.isArray(result)) return asText(result);
      return asText(result.map(compactContainer));
    },
  );

  server.registerTool(
    "portainer_get_container",
    {
      title: "Portainer: Get Container",
      description:
        "Get container details (state, config, env, ports, mounts) by ID or name. Compact projection by default; set full=true for the complete Docker inspect JSON (NetworkSettings internals, GraphDriver, and other low-value detail the compact view omits).",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          full: z
            .boolean()
            .optional()
            .describe(
              "Return the complete Docker inspect JSON (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, full }) => {
      const result = await p.getContainer(endpoint_id, container_id);
      return asText(full ? result : compactContainerInspect(result));
    },
  );

  server.registerTool(
    "portainer_compare_env_values",
    {
      title: "Portainer: Compare Two Env Values",
      description:
        "Check whether two containers' env var values are equal, without ever exposing either value. Fetches both raw values server-side, hashes them, and returns only match: true/false plus found/empty flags for each side — never the values or a hash of them. Use this instead of eyeballing two redacted portainer_get_container results when two services are supposed to share a secret (e.g. a shared bearer token between a client and the service it authenticates to) and you need to confirm they actually match. An empty or missing value on either side is never reported as a match, even against another empty/missing value.",
      inputSchema: z
        .object({
          a: z
            .object({
              endpoint_id: z.number().int().describe("Endpoint ID for side A"),
              container_id: z
                .string()
                .describe("Container ID or name for side A"),
              var_name: z
                .string()
                .describe("Env var name to compare on side A"),
            })
            .strict(),
          b: z
            .object({
              endpoint_id: z.number().int().describe("Endpoint ID for side B"),
              container_id: z
                .string()
                .describe("Container ID or name for side B"),
              var_name: z
                .string()
                .describe("Env var name to compare on side B"),
            })
            .strict(),
        })
        .strict(),
    },
    async ({ a, b }) =>
      asText(
        await p.compareEnvValues(
          {
            endpointId: a.endpoint_id,
            containerId: a.container_id,
            varName: a.var_name,
          },
          {
            endpointId: b.endpoint_id,
            containerId: b.container_id,
            varName: b.var_name,
          },
        ),
      ),
  );

  server.registerTool(
    "portainer_container_logs",
    {
      title: "Portainer: Container Logs",
      description:
        "Fetch a container's logs, timestamped, as clean newline-delimited text. Docker's stream-multiplexing frame headers (present on non-TTY containers) are stripped server-side before the result is returned. Bound the payload with since/until instead of guessing at a tail count when you want a specific time window.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          tail: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe("Number of log lines to return (default 100)"),
          since: z
            .string()
            .optional()
            .describe(
              'Only return logs at or after this time. Accepts a Unix timestamp (seconds), an RFC3339 datetime (e.g. "2026-08-28T20:00:00Z"), or a relative duration counted back from now (e.g. "10m", "1h30m", "45s") -- same convention as `docker logs --since`.',
            ),
          until: z
            .string()
            .optional()
            .describe(
              "Only return logs before this time. Same accepted formats as `since`.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, tail, since, until }) =>
      asText(
        await p.containerLogs(endpoint_id, container_id, tail ?? 100, {
          since,
          until,
        }),
      ),
  );

  server.registerTool(
    "portainer_container_start",
    {
      title: "Portainer: Start Container",
      description:
        "Start a stopped container on a Docker endpoint. Pure passthrough to Docker's POST /containers/{id}/start.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
        })
        .strict(),
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
      inputSchema: z
        .object({
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
        })
        .strict(),
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
      inputSchema: z
        .object({
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
        })
        .strict(),
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
      inputSchema: z
        .object({
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
        })
        .strict(),
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
    "portainer_container_delete",
    {
      title: "Portainer: Delete Container",
      description:
        "Delete a container. HIGH BLAST RADIUS AND IRREVERSIBLE — the container and its writable layer are gone. Anonymous (unnamed) volumes are removed only if remove_volumes=true; named volumes are never removed by this call. Docker refuses to delete a running container unless force=true, which kills it first (skipping graceful shutdown) then removes it. If the container belongs to a Portainer-managed stack, prefer portainer_delete_stack (or a redeploy) instead — deleting one container directly desyncs it from the stack record, and it may simply be recreated on the next redeploy.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          container_id: z.string().describe("Container ID or name"),
          force: z
            .boolean()
            .optional()
            .describe(
              "Kill the container first if it's running (default false — Docker refuses to delete a running container otherwise)",
            ),
          remove_volumes: z
            .boolean()
            .optional()
            .describe(
              "Also remove anonymous volumes associated with the container (default false). Never removes named volumes.",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge the irreversible action",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, force, remove_volumes }) => {
      await p.containerDelete(endpoint_id, container_id, {
        force,
        removeVolumes: remove_volumes,
      });
      return asText({
        ok: true,
        action: "delete",
        endpoint_id,
        container_id,
      });
    },
  );

  server.registerTool(
    "portainer_recreate_container",
    {
      title: "Portainer: Recreate Container",
      description:
        "Pull the image and recreate a single container, preserving its Config and HostConfig (env, mounts, networks, restart policy, etc). Cleaner than stack-redeploy for 'update one service after pushing a new image' workflows. The old container is stopped and removed; the new one keeps the same name and resource controls. Synchronous; the response is the new container's full inspect JSON plus an `imagePrune` field — recreate automatically runs a dangling-only image prune on the endpoint afterward, cleaning up the digest the recreate just superseded. TIMEOUT RISK: image pull + stop + remove + create all happen inline before this call returns, so a large image over a slow connection can take minutes and may exceed the calling MCP client's own tool-call timeout. If that happens, the recreate is NOT aborted server-side — it keeps running in Portainer regardless of whether the client gave up waiting. If this call appears to time out, verify the actual result with portainer_get_container rather than assuming it failed. For a large image, prefer calling portainer_pull_image first, then this tool with pull_image: false — the pull (slow, safe to retry) is decoupled from the recreate (fast, the actually destructive part), so a timeout can no longer land mid-recreate.",
      inputSchema: z
        .object({
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
        })
        .strict(),
    },
    async ({ endpoint_id, container_id, pull_image }) =>
      asText(
        await p.recreateContainer(endpoint_id, container_id, {
          pullImage: pull_image ?? true,
        }),
      ),
  );
}
