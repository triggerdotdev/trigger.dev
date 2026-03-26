import { ComputeGatewayClient } from "@trigger.dev/core/v3/compute";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { PrismaClientOrTransaction } from "~/db.server";

type TemplateCreationMode = "required" | "shadow" | "skip";

export class ComputeTemplateCreationService {
  private client: ComputeGatewayClient | undefined;

  constructor() {
    if (env.COMPUTE_GATEWAY_URL) {
      this.client = new ComputeGatewayClient({
        gatewayUrl: env.COMPUTE_GATEWAY_URL,
        authToken: env.COMPUTE_GATEWAY_AUTH_TOKEN,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      });
    }
  }

  async resolveMode(
    projectId: string,
    prisma: PrismaClientOrTransaction
  ): Promise<TemplateCreationMode> {
    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: {
        defaultWorkerGroup: {
          select: { workloadType: true },
        },
      },
    });

    if (project?.defaultWorkerGroup?.workloadType === "MICROVM") {
      return "required";
    }

    // TODO: check private beta feature flag for org

    const rolloutPct = Number(env.COMPUTE_TEMPLATE_SHADOW_ROLLOUT_PCT ?? "0");
    if (rolloutPct > 0 && Math.random() * 100 < rolloutPct) {
      return "shadow";
    }

    return "skip";
  }

  async createTemplate(imageReference: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Compute gateway not configured" };
    }

    try {
      await this.client.createTemplate({
        image: imageReference,
        cpu: 0.5,
        memory_mb: 512,
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to create compute template", {
        imageReference,
        error: message,
      });
      return { success: false, error: message };
    }
  }
}
