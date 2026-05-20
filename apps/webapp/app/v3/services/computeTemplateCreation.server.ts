import { ComputeClient, stripImageDigest } from "@internal/compute";
import type { TemplateCreateResultEntry } from "@internal/compute";
import { MachinePresetName } from "@trigger.dev/core/v3";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "./baseService.server";
import { FailDeploymentService } from "./failDeployment.server";
import { resolveComputeAccess } from "../regionAccess.server";

type TemplateCreationMode = "required" | "shadow" | "skip";

type ResolvedPreset = {
  name: MachinePresetName;
  cpu: number;
  memory_gb: number;
};

export class ComputeTemplateCreationService {
  private client: ComputeClient | undefined;
  private presets: ResolvedPreset[];
  private requiredPresets: Set<MachinePresetName>;

  constructor() {
    if (env.COMPUTE_GATEWAY_URL) {
      this.client = new ComputeClient({
        gatewayUrl: env.COMPUTE_GATEWAY_URL,
        authToken: env.COMPUTE_GATEWAY_AUTH_TOKEN,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      });
    }

    this.presets = env.COMPUTE_TEMPLATE_MACHINE_PRESETS.map((name) => {
      const machine = machinePresetFromName(name);
      return { name, cpu: machine.cpu, memory_gb: machine.memory };
    });
    this.requiredPresets = new Set(env.COMPUTE_TEMPLATE_MACHINE_PRESETS_REQUIRED);
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
        .then((outcome) => {
          if (outcome.error) {
            logger.error("Shadow template creation failed", {
              id: options.deploymentFriendlyId,
              imageReference: options.imageReference,
              error: outcome.error,
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
      try {
        await options.writer.write(
          `event: log\ndata: ${JSON.stringify({ message: "Building compute template..." })}\n\n`
        );
      } catch {
        // Stream may be closed if client disconnected - continue with template creation
      }
    }

    logger.info("Creating compute template (required mode)", {
      id: options.deploymentFriendlyId,
      imageReference: options.imageReference,
      presets: this.presets.map((p) => p.name),
      requiredPresets: [...this.requiredPresets],
    });

    const outcome = await this.createTemplate(options.imageReference);
    const failureMessage = this.failureMessageForRequiredMode(
      outcome,
      options.deploymentFriendlyId,
      options.imageReference
    );

    if (failureMessage) {
      logger.error("Compute template creation failed", {
        id: options.deploymentFriendlyId,
        imageReference: options.imageReference,
        error: failureMessage,
      });

      const failService = new FailDeploymentService();
      await failService.call(options.authenticatedEnv, options.deploymentFriendlyId, {
        error: {
          name: "TemplateCreationFailed",
          message: `Failed to create compute template: ${failureMessage}`,
        },
      });

      throw new ServiceValidationError(`Compute template creation failed: ${failureMessage}`);
    }

    logger.info("Compute template created", {
      id: options.deploymentFriendlyId,
      imageReference: options.imageReference,
      results: outcome.results.length,
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

    if (!project) {
      return "skip";
    }

    if (project.defaultWorkerGroup?.workloadType === "MICROVM") {
      return "required";
    }

    const hasComputeAccess = await resolveComputeAccess(prisma, project.organization.featureFlags);

    if (hasComputeAccess) {
      return "shadow";
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
  ): Promise<CreateTemplateOutcome> {
    if (!this.client) {
      return { error: "Compute gateway not configured", results: [] };
    }

    try {
      const machineConfigs = this.presets.map((p) => ({
        cpu: p.cpu,
        memory_gb: p.memory_gb,
      }));

      const response = await this.client.templates.create({
        image: stripImageDigest(imageReference),
        machine_configs: machineConfigs,
        background: options?.background,
      });

      // Background mode (202 Accepted): no body to inspect.
      if (options?.background || !response) {
        return { results: [] };
      }

      return {
        error: response.error,
        results: response.results,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to create compute template", {
        imageReference,
        error: message,
      });
      return { error: message, results: [] };
    }
  }

  // Returns a human-readable failure message if any required preset failed
  // or the request itself failed. Optional preset failures are logged and
  // do not contribute to the message. Returns undefined on success.
  private failureMessageForRequiredMode(
    outcome: CreateTemplateOutcome,
    deploymentFriendlyId: string,
    imageReference: string
  ): string | undefined {
    if (this.presets.length === 0) {
      return undefined;
    }

    const failures: string[] = [];

    this.presets.forEach((preset) => {
      const isRequired = this.requiredPresets.has(preset.name);
      // Match results to presets by (cpu, memory_gb) content with a small
      // epsilon to tolerate float round-trip noise (memory_gb passes through
      // gb -> mb -> gb conversion in the compute layer).
      const result = outcome.results.find(
        (r) =>
          Math.abs(r.machine_config.cpu - preset.cpu) < 1e-9 &&
          Math.abs(r.machine_config.memory_gb - preset.memory_gb) < 1e-9
      );

      if (!result) {
        if (isRequired) {
          failures.push(`${preset.name}: not built`);
        } else {
          logger.warn("Optional compute template preset not built", {
            id: deploymentFriendlyId,
            imageReference,
            preset: preset.name,
          });
        }
        return;
      }

      if (result.error) {
        if (isRequired) {
          failures.push(`${preset.name}: ${result.error}`);
        } else {
          logger.warn("Optional compute template preset failed", {
            id: deploymentFriendlyId,
            imageReference,
            preset: preset.name,
            error: result.error,
          });
        }
      }
    });

    // Surface request-level errors only when no per-preset failure attributed.
    if (outcome.error && failures.length === 0) {
      failures.push(outcome.error);
    }

    return failures.length > 0 ? failures.join("; ") : undefined;
  }
}

type CreateTemplateOutcome = {
  error?: string;
  results: TemplateCreateResultEntry[];
};
