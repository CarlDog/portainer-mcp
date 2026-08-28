import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import { compactEndpoint, type PortainerClient } from "../portainer.js";

export function registerSystemTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_endpoints",
    {
      title: "Portainer: List Endpoints",
      description:
        "List all Portainer environments (Docker hosts/Swarms registered with Portainer). Compact projection by default (Id, Name, Type, URL, Status, GroupId); set full=true for the raw objects, which include each endpoint's Snapshots — a full Docker system snapshot per endpoint, by far the largest field.",
      inputSchema: z
        .object({
          full: z
            .boolean()
            .optional()
            .describe(
              "Return complete endpoint objects including Snapshots (default: compact projection)",
            ),
        })
        .strict(),
    },
    async ({ full }) => {
      const result = await p.listEndpoints();
      if (full || !Array.isArray(result)) return asText(result);
      return asText(result.map(compactEndpoint));
    },
  );

  server.registerTool(
    "portainer_system_status",
    {
      title: "Portainer: System Status",
      description: "Get Portainer version and system info.",
      inputSchema: z.object({}).strict(),
    },
    async () => asText(await p.systemStatus()),
  );
}
