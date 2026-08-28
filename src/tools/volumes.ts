import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import type { PortainerClient } from "../portainer.js";

export function registerVolumeTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_volumes",
    {
      title: "Portainer: List Volumes",
      description:
        "List Docker volumes on an endpoint. Useful for spotting orphan/unused volumes accumulated from deleted stacks. Optional filters: `dangling: true` returns only volumes with no container reference (true orphans), `dangling: false` returns only in-use volumes, omit for all. `name` is a substring filter on volume name.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          dangling: z
            .boolean()
            .optional()
            .describe(
              "Filter by usage. true = only unused (no container references), false = only in-use, omit = all volumes.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "Substring filter on volume name (Docker's name filter).",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, dangling, name }) =>
      asText(await p.listVolumes(endpoint_id, { dangling, name })),
  );

  server.registerTool(
    "portainer_inspect_volume",
    {
      title: "Portainer: Inspect Volume",
      description:
        "Get full details for a single Docker volume — Mountpoint (host path), Driver, CreatedAt, Labels (including the Compose project label that maps to a stack), Scope, and Options. Use this to decide whether an unused volume is safe to remove (check Labels for the originating stack name; check Mountpoint size on disk if needed).",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          volume_name: z
            .string()
            .min(1)
            .describe(
              "Volume name (from portainer_list_volumes). Names with special characters are URL-encoded automatically.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, volume_name }) =>
      asText(await p.inspectVolume(endpoint_id, volume_name)),
  );
}
