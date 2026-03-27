import { ComputeClient, stripImageDigest } from "@internal/compute";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG, makeFlag } from "~/v3/featureFlags.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "./baseService.server";
import { FailDeploymentService } from "./failDeployment.server";

type TemplateCreationMode = "required" | "shadow" | "skip";

export class ComputeTemplateCreationService {
  private client: ComputeClient | undefined;

  constructor() {
    if (env.COMPUTE_GATEWAY_URL) {
      this.client = new ComputeClient({
        gatewayUrl: env.COMPUTE_GATEWAY_URL,
        authToken: env.COMPUTE_GATEWAY_AUTH_TOKEN,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      });
    }
  }

  /**
   * Handle template creation for a deployment. Call this before setting DEPLOYED.
   *
   * - Required mode: creates template synchronously, fails deployment on error
   * - Shadow mode: fires background template creation (returns immediately)
   * - Skip: no-op
   *
   * Throws ServiceValidationError if required mode fails (caller should stop finalize).
   */
  async handleDeployTemplate(options: {
    projectId: string;
    imageReference: string;
    deploymentFriendlyId: string;
    authenticatedEnv: AuthenticatedEnvironment;
    prisma: PrismaClientOrTransaction;
    writer?: WritableStreamDefaultWriter;
  }): Promise<void> {
    const mode = await this.resolveMode(options.projectId, options.prisma);

    if (mode === "skip") {
      return;
    }

    if (mode === "shadow") {
      this.createTemplate(options.imageReference, { background: true })
        .then((result) => {
          if (!result.success) {
            logger.error("Shadow template creation failed", {
              id: options.deploymentFriendlyId,
              imageReference: options.imageReference,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          logger.error("Shadow template creation threw unexpectedly", {
            id: options.deploymentFriendlyId,
            imageReference: options.imageReference,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    // Required mode
    if (options.writer) {
      await options.writer.write(
        `event: log\ndata: ${JSON.stringify({ message: "Building compute template..." })}\n\n`
      );
    }

    logger.info("Creating compute template (required mode)", {
      id: options.deploymentFriendlyId,
      imageReference: options.imageReference,
    });

    const result = await this.createTemplate(options.imageReference);

    if (!result.success) {
      logger.error("Compute template creation failed", {
        id: options.deploymentFriendlyId,
        imageReference: options.imageReference,
        error: result.error,
      });

      const failService = new FailDeploymentService();
      await failService.call(options.authenticatedEnv, options.deploymentFriendlyId, {
        error: {
          name: "TemplateCreationFailed",
          message: `Failed to create compute template: ${result.error}`,
        },
      });

      throw new ServiceValidationError(
        `Compute template creation failed: ${result.error}`
      );
    }

    logger.info("Compute template created", {
      id: options.deploymentFriendlyId,
      imageReference: options.imageReference,
    });
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
      // Templates are resource-agnostic - these values don't affect template content.
      const machine = machinePresetFromName("small-1x");

      await this.client.templates.create({
        image: stripImageDigest(imageReference),
        cpu: machine.cpu,
        memory_mb: machine.memory * 1024,
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
