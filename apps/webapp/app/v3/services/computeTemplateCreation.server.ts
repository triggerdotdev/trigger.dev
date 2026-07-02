import { ComputeClient, stripImageDigest } from "@internal/compute";
import type { TemplateCreateResultEntry } from "@internal/compute";
import type { MachinePresetName } from "@trigger.dev/core/v3";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "./baseService.server";
import { FailDeploymentService } from "./failDeployment.server";
import { resolveComputeAccess } from "../regionAccess.server";
import { isOrgMigrated } from "~/runEngine/concerns/computeMigration.server";
import { backingForQueue, workerRegionRegistry } from "~/v3/workerRegions.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { startActiveSpan, attributesFromAuthenticatedEnv } from "~/v3/tracer.server";

type TemplateCreationMode = "required" | "shadow" | "skip";

// Why the mode was chosen — slices the compute.template.create span by path.
type TemplateModeReason =
  | "no-client"
  | "no-project"
  | "microvm-native"
  | "migrated"
  | "compute-access"
  | "rollout"
  | "none";

type ResolvedTemplateMode = {
  mode: TemplateCreationMode;
  migrated: boolean;
  reason: TemplateModeReason;
};

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
    return startActiveSpan("compute.template.create", async (span) => {
      const { mode, migrated, reason } = await this.resolveMode(options.projectId, options.prisma);

      span.setAttributes({
        ...attributesFromAuthenticatedEnv(options.authenticatedEnv),
        "compute.template.mode": mode,
        "compute.template.migrated": migrated,
        "compute.template.reason": reason,
        "compute.template.deployment_id": options.deploymentFriendlyId,
        "compute.template.presets_total": this.presets.length,
        "compute.template.presets_required": this.requiredPresets.size,
      });

      if (mode === "skip") {
        span.setAttribute("compute.template.result", "skipped");
        return;
      }

      if (mode === "shadow") {
        // Shadow is fire-and-forget (background build), so the span only records
        // that it was dispatched — the build outcome lands server-side later.
        span.setAttribute("compute.template.result", "shadow_dispatched");
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
      span.setAttribute("compute.template.presets_built", outcome.results.length);

      const failureMessage = this.failureMessageForRequiredMode(
        outcome,
        options.deploymentFriendlyId,
        options.imageReference
      );

      if (failureMessage) {
        span.setAttributes({
          "compute.template.result": "failed",
          "compute.template.failure": failureMessage,
        });

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

      span.setAttribute("compute.template.result", "created");
      logger.info("Compute template created", {
        id: options.deploymentFriendlyId,
        imageReference: options.imageReference,
        results: outcome.results.length,
      });
    });
  }

  async resolveMode(
    projectId: string,
    prisma: PrismaClientOrTransaction
  ): Promise<ResolvedTemplateMode> {
    if (!this.client) {
      return { mode: "skip", migrated: false, reason: "no-client" };
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: {
        defaultWorkerGroup: {
          select: { workloadType: true, masterQueue: true },
        },
        organization: {
          select: { id: true, featureFlags: true },
        },
      },
    });

    if (!project) {
      return { mode: "skip", migrated: false, reason: "no-project" };
    }

    if (project.defaultWorkerGroup?.workloadType === "MICROVM") {
      return { mode: "required", migrated: false, reason: "microvm-native" };
    }

    // Migrated orgs route runs to the compute backing even though their stored
    // default is still the container region, so they need a compute template too.
    // shadow mode: never fail a deploy over a backing the org didn't opt into.
    // A cold registry read returns no backing, so this is simply skipped until loaded.
    const defaultQueue = project.defaultWorkerGroup?.masterQueue;
    if (defaultQueue && backingForQueue(defaultQueue, workerRegionRegistry.current() ?? [])) {
      const decision = {
        orgId: project.organization.id,
        orgFeatureFlags: project.organization.featureFlags as Record<string, unknown> | null,
        flags: globalFlagsRegistry.current(),
      };
      // Per-org override needs no plan; only the percentage path does. So skip the
      // external entitlement lookup unless it could matter, and degrade gracefully
      // if it throws - a shadow-template check must never fail a deploy.
      let migrated = isOrgMigrated({ ...decision, planType: undefined });
      if (!migrated && (decision.flags?.computeMigrationEnabled ?? false)) {
        let planType: string | undefined;
        try {
          planType = (await getEntitlement(project.organization.id))?.plan?.type;
        } catch (error) {
          logger.warn("compute migration: entitlement lookup failed; skipping shadow template", {
            organizationId: project.organization.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        migrated = isOrgMigrated({ ...decision, planType });
      }
      if (migrated) {
        // required => template built at deploy (deploy fails on error); off => shadow.
        return {
          mode: decision.flags?.computeMigrationRequireTemplate ? "required" : "shadow",
          migrated: true,
          reason: "migrated",
        };
      }
    }

    const hasComputeAccess = await resolveComputeAccess(prisma, project.organization.featureFlags);

    if (hasComputeAccess) {
      return { mode: "shadow", migrated: false, reason: "compute-access" };
    }

    const rolloutPct = Number(env.COMPUTE_TEMPLATE_SHADOW_ROLLOUT_PCT ?? "0");
    if (rolloutPct > 0 && Math.random() * 100 < rolloutPct) {
      return { mode: "shadow", migrated: false, reason: "rollout" };
    }

    return { mode: "skip", migrated: false, reason: "none" };
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
