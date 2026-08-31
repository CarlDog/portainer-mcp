import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText } from "../util.js";
import type { PortainerClient } from "../portainer.js";

export function registerImageTools(
  server: McpServer,
  p: PortainerClient,
): void {
  server.registerTool(
    "portainer_list_images",
    {
      title: "Portainer: List Images",
      description:
        "List Docker images on an endpoint with usage info (`used: true` if at least one container references the image). Use this to see what portainer_prune_images would remove, or to spot old digests left behind by a rebuild-and-repush. Compact by design (id, tags, size, created, used) — no full/compact toggle needed.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
        })
        .strict(),
    },
    async ({ endpoint_id }) => asText(await p.listImages(endpoint_id)),
  );

  server.registerTool(
    "portainer_prune_images",
    {
      title: "Portainer: Prune Images",
      description:
        "Bulk-delete unused Docker images on an endpoint. Default removes only dangling/untagged images (Docker's own `docker image prune` default) — the leftovers once a rebuild-and-repush moves a tag to a new digest. Set all_unused=true to also remove tagged images not backing any container right now (like `docker image prune -a`) — reclaims more space but can delete an image kept around for rollback. Note: portainer_redeploy_stack, portainer_update_stack_file, portainer_redeploy_git_stack, and portainer_recreate_container already run the dangling-only version of this automatically after every call — reach for this tool for the all_unused case, or to clear backlog on an endpoint outside a redeploy.",
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          all_unused: z
            .boolean()
            .optional()
            .describe(
              "true = remove all unused images including tagged ones (docker image prune -a). false/omit = dangling/untagged only (safe default).",
            ),
          confirm: z
            .literal(true)
            .describe(
              "Must be exactly true to acknowledge this bulk-deletes images",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, all_unused }) =>
      asText(
        await p.pruneImages(endpoint_id, { allUnused: all_unused ?? false }),
      ),
  );

  server.registerTool(
    "portainer_pull_image",
    {
      title: "Portainer: Pull Image",
      description:
        'Pull a Docker image on an endpoint without touching any container. Use this before portainer_recreate_container(pull_image: false) when the image is large — splitting the slow pull off from the fast recreate avoids the MCP client\'s own tool-call timeout landing on the destructive half of the operation. A pull is safe to retry after a timeout: Docker caches already-downloaded layers, so a retry resumes rather than restarts from scratch (unlike a timed-out recreate, where a blind retry risks racing a second recreate against the one still running). Reports whether a new layer was actually downloaded (`status: "downloaded"`) or the image was already current (`status: "up-to-date"`) — a call returning at all doesn\'t by itself say which. No confirm gate: pulling only adds an image, it never removes or modifies anything running. Public/anonymous pulls need only endpoint_id and image. For a private registry already configured in Portainer (Settings > Registries), pass registry_id to reference that stored credential; no username, password, or token transits the MCP call.',
      inputSchema: z
        .object({
          endpoint_id: z.number().int().describe("Endpoint ID"),
          image: z
            .string()
            .min(1)
            .describe(
              'Image reference to pull, e.g. "nginx:1.27" or "ghcr.io/carldog/portainer-mcp:latest". Omitting a tag pulls "latest".',
            ),
          registry_id: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .optional()
            .describe(
              "Optional Portainer stored-registry credential ID. References Settings > Registries without exposing the credential itself.",
            ),
        })
        .strict(),
    },
    async ({ endpoint_id, image, registry_id }) =>
      asText(await p.pullImage(endpoint_id, image, registry_id)),
  );
}
