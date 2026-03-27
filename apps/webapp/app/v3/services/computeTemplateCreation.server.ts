import { ComputeGatewayClient } from "@internal/compute";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG, makeFlag } from "~/v3/featureFlags.server";

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
    if (!this.client) {
      return "skip";
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: {
        defaultWorkerGroup: {
          select: { workloadType: true },
        },
        organization: {
          select: { featureFlags: true },
        },
      },
    });

    if (project?.defaultWorkerGroup?.workloadType === "MICROVM") {
      return "required";
    }

    const flag = makeFlag(prisma);
    const hasComputeAccess = await flag({
      key: FEATURE_FLAG.hasComputeAccess,
      defaultValue: false,
      overrides: (project?.organization?.featureFlags as Record<string, unknown>) ?? {},
    });

    if (hasComputeAccess) {
      return "required";
    }

    const rolloutPct = Number(env.COMPUTE_TEMPLATE_SHADOW_ROLLOUT_PCT ?? "0");
    if (rolloutPct > 0 && Math.random() * 100 < rolloutPct) {
      return "shadow";
    }

    return "skip";
  }

  async createTemplate(
    imageReference: string,
    options?: { background?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: "Compute gateway not configured" };
    }

    try {
      await this.client.createTemplate({
        image: imageReference,
        cpu: 0.5,
        memory_mb: 512,
        background: options?.background,
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
