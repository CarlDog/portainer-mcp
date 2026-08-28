import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import type { PortainerClient } from "../portainer.js";

export function registerNetworkTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_networks",
    {
      title: "Portainer: List Networks",
      description:
        "List Docker networks on an endpoint. Useful for spotting orphan networks left behind by deleted stacks (Compose creates one network per project by default). Optional filters: `dangling: true` returns only networks not used by any container, `dangling: false` returns only in-use networks, omit for all. `name` is a substring filter on network name.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          dangling: z
            .boolean()
            .optional()
            .describe(
              "Filter by usage. true = only unused (no container references), false = only in-use, omit = all networks.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "Substring filter on network name (Docker's name filter).",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, dangling, name }) =>
      asText(await p.listNetworks(endpoint_id, { dangling, name })),
  );

  server.registerTool(
    "portainer_inspect_network",
    {
      title: "Portainer: Inspect Network",
      description:
        "Get full details for a single Docker network — Driver, Scope, IPAM config (subnets/gateways), connected Containers, and Labels (including the Compose project label that maps to a stack). Use this to decide whether an unused network is safe to remove.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          network_id: z
            .string()
            .min(1)
            .describe(
              "Network ID or name (from portainer_list_networks). Values with special characters are URL-encoded automatically.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, network_id }) =>
      asText(await p.inspectNetwork(endpoint_id, network_id)),
  );

  server.registerTool(
    "portainer_prune_networks",
    {
      title: "Portainer: Prune Networks",
      description:
        "Remove all Docker networks on an endpoint not used by any container (like `docker network prune`). Lower risk than volume pruning would be — an unused network holds no data to lose, and Compose recreates it automatically on the next redeploy if still needed. Still requires confirm: true, and a network can appear briefly unused during a stack redeploy's container-swap window — avoid running this immediately after a bulk redeploy across many stacks.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge this removes unused networks",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id }) => asText(await p.pruneNetworks(endpoint_id)),
  );
}
