import { customAlphabet } from "nanoid";
import { ServiceValidationError, WithRunEngine, WithRunEngineOptions } from "../baseService.server";
import { createHash, timingSafeEqual } from "crypto";
import { logger } from "~/services/logger.server";
import {
  Prisma,
  RuntimeEnvironment,
  WorkerInstanceGroup,
  WorkerInstanceGroupType,
} from "@trigger.dev/database";
import { z } from "zod";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import {
  TaskRunExecutionResult,
  DequeuedMessage,
  CompleteRunAttemptResult,
  StartRunAttemptResult,
  ExecutionResult,
  MachinePreset,
  MachineResources,
  CheckpointInput,
} from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { $transaction } from "~/db.server";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import {
  CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
  fromFriendlyId,
} from "@trigger.dev/core/v3/isomorphic";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { defaultMachine } from "~/services/platform.v3.server";

export class WorkerGroupTokenService extends WithRunEngine {
  private readonly tokenPrefix = "tr_wgt_";
  private readonly tokenLength = 40;
  private readonly tokenChars = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  private readonly tokenGenerator = customAlphabet(this.tokenChars, this.tokenLength);

  async createToken() {
    const rawToken = await this.generateToken();

    const workerGroupToken = await this._prisma.workerGroupToken.create({
      data: {
        tokenHash: rawToken.hash,
      },
    });

    return {
      id: workerGroupToken.id,
      tokenHash: workerGroupToken.tokenHash,
      plaintext: rawToken.plaintext,
    };
  }

  async findWorkerGroup({ token }: { token: string }) {
    const tokenHash = await this.hashToken(token);

    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        token: {
          tokenHash,
        },
      },
    });

    if (!workerGroup) {
      logger.warn("[WorkerGroupTokenService] No matching worker group found", { token });
      return null;
    }

    return workerGroup;
  }

  async rotateToken({ workerGroupId }: { workerGroupId: string }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        id: workerGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupTokenService] WorkerGroup not found", { workerGroupId });
      return;
    }

    const rawToken = await this.generateToken();

    const workerGroupToken = await this._prisma.workerGroupToken.update({
      where: {
        id: workerGroup.tokenId,
      },
      data: {
        tokenHash: rawToken.hash,
      },
    });

    if (!workerGroupToken) {
      logger.error("[WorkerGroupTokenService] WorkerGroupToken not found", { workerGroupId });
      return;
    }

    return {
      id: workerGroupToken.id,
      tokenHash: workerGroupToken.tokenHash,
      plaintext: rawToken.plaintext,
    };
  }

  private async hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private async generateToken() {
    const plaintext = `${this.tokenPrefix}${this.tokenGenerator()}`;
    const hash = await this.hashToken(plaintext);

    return {
      plaintext,
      hash,
    };
  }

  async authenticate(request: Request): Promise<AuthenticatedWorkerInstance | undefined> {
    const token = request.headers.get("Authorization")?.replace("Bearer ", "").trim();

    if (!token) {
      logger.error("[WorkerGroupTokenService] Token not found in request", {
        headers: this.sanitizeHeaders(request),
      });
      return;
    }

    if (!token.startsWith(this.tokenPrefix)) {
      logger.error("[WorkerGroupTokenService] Token does not start with expected prefix", {
        token,
        prefix: this.tokenPrefix,
      });
      return;
    }

    const instanceName = request.headers.get(WORKER_HEADERS.INSTANCE_NAME);

    if (!instanceName) {
      logger.error("[WorkerGroupTokenService] Instance name not found in request", {
        headers: this.sanitizeHeaders(request),
      });
      return;
    }

    const workerGroup = await this.findWorkerGroup({ token });

    if (!workerGroup) {
      logger.warn("[WorkerGroupTokenService] Worker group not found", { token });
      return;
    }

    if (workerGroup.type === WorkerInstanceGroupType.MANAGED) {
      const managedWorkerSecret = request.headers.get(WORKER_HEADERS.MANAGED_SECRET);

      if (!managedWorkerSecret) {
        logger.error("[WorkerGroupTokenService] Managed secret not found in request", {
          headers: this.sanitizeHeaders(request),
        });
        return;
      }

      const encoder = new TextEncoder();

      const a = encoder.encode(managedWorkerSecret);
      const b = encoder.encode(env.MANAGED_WORKER_SECRET);

      if (a.byteLength !== b.byteLength) {
        logger.error("[WorkerGroupTokenService] Managed secret length mismatch", {
          managedWorkerSecret,
          headers: this.sanitizeHeaders(request),
        });
        return;
      }

      if (!timingSafeEqual(a, b)) {
        logger.error("[WorkerGroupTokenService] Managed secret mismatch", {
          managedWorkerSecret,
          headers: this.sanitizeHeaders(request),
        });
        return;
      }
    }

    const workerInstance = await this.getOrCreateWorkerInstance({
      workerGroup,
      instanceName,
      deploymentId: request.headers.get(WORKER_HEADERS.DEPLOYMENT_ID) ?? undefined,
    });

    if (!workerInstance) {
      logger.error("[WorkerGroupTokenService] Unable to get or create worker instance", {
        workerGroup,
        instanceName,
      });
      return;
    }

    if (workerGroup.type === WorkerInstanceGroupType.MANAGED) {
      return new AuthenticatedWorkerInstance({
        prisma: this._prisma,
        engine: this._engine,
        type: WorkerInstanceGroupType.MANAGED,
        name: workerGroup.name,
        workerGroupId: workerGroup.id,
        workerInstanceId: workerInstance.id,
        masterQueue: workerGroup.masterQueue,
        environment: null,
        runnerId: request.headers.get(WORKER_HEADERS.RUNNER_ID) ?? undefined,
      });
    }

    if (!workerInstance.environment) {
      logger.error(
        "[WorkerGroupTokenService] Unmanaged worker instance not linked to environment",
        { workerGroup, workerInstance }
      );
      return;
    }

    if (!workerInstance.deployment) {
      logger.error("[WorkerGroupTokenService] Unmanaged worker instance not linked to deployment", {
        workerGroup,
        workerInstance,
      });
      return;
    }

    if (!workerInstance.deployment.workerId) {
      logger.error(
        "[WorkerGroupTokenService] Unmanaged worker instance deployment not linked to background worker",
        { workerGroup, workerInstance }
      );
      return;
    }

    return new AuthenticatedWorkerInstance({
      prisma: this._prisma,
      engine: this._engine,
      type: WorkerInstanceGroupType.UNMANAGED,
      name: workerGroup.name,
      workerGroupId: workerGroup.id,
      workerInstanceId: workerInstance.id,
      masterQueue: workerGroup.masterQueue,
      environmentId: workerInstance.environment.id,
      deploymentId: workerInstance.deployment.id,
      backgroundWorkerId: workerInstance.deployment.workerId,
      environment: workerInstance.environment,
    });
  }

  private async getOrCreateWorkerInstance({
    workerGroup,
    instanceName,
    deploymentId,
  }: {
    workerGroup: WorkerInstanceGroup;
    instanceName: string;
    deploymentId?: string;
  }) {
    return await $transaction(this._prisma, async (tx) => {
      const resourceIdentifier = deploymentId ? `${deploymentId}:${instanceName}` : instanceName;

      const workerInstance = await tx.workerInstance.findFirst({
        where: {
          workerGroupId: workerGroup.id,
          resourceIdentifier,
        },
        include: {
          deployment: true,
          environment: true,
        },
      });

      if (workerInstance) {
        return workerInstance;
      }

      if (workerGroup.type === WorkerInstanceGroupType.MANAGED) {
        if (deploymentId) {
          logger.warn(
            "[WorkerGroupTokenService] Shared worker group instances should not authenticate with a deployment ID",
            {
              workerGroup,
              workerInstance,
              deploymentId,
            }
          );
        }

        try {
          const newWorkerInstance = await tx.workerInstance.create({
            data: {
              workerGroupId: workerGroup.id,
              name: instanceName,
              resourceIdentifier,
            },
            include: {
              // This will always be empty for shared worker instances, but required for types
              deployment: true,
              environment: true,
            },
          });
          return newWorkerInstance;
        } catch (error) {
          // Gracefully handle race conditions when connecting for the first time
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            // Unique constraint violation
            if (error.code === "P2002") {
              try {
                const existingWorkerInstance = await tx.workerInstance.findFirst({
                  where: {
                    workerGroupId: workerGroup.id,
                    resourceIdentifier,
                  },
                  include: {
                    deployment: true,
                    environment: true,
                  },
                });
                return existingWorkerInstance;
              } catch (error) {
                logger.error("[WorkerGroupTokenService] Failed to find worker instance", {
                  workerGroup,
                  workerInstance,
                  deploymentId,
                });
                return;
              }
            }
          }
        }
      }

      if (!workerGroup.projectId || !workerGroup.organizationId) {
        logger.error(
          "[WorkerGroupTokenService] Unmanaged worker group missing project or organization",
          {
            workerGroup,
            workerInstance,
            deploymentId,
          }
        );
        return;
      }

      if (!deploymentId) {
        logger.error("[WorkerGroupTokenService] Unmanaged worker group required deployment ID", {
          workerGroup,
          workerInstance,
        });
        return;
      }

      // Unmanaged workers instances are locked to a specific deployment version

      const deployment = await tx.workerDeployment.findFirst({
        where: {
          ...(deploymentId.startsWith("deployment_")
            ? {
                friendlyId: deploymentId,
              }
            : {
                id: deploymentId,
              }),
        },
      });

      if (!deployment) {
        logger.error("[WorkerGroupTokenService] Deployment not found", {
          workerGroup,
          workerInstance,
          deploymentId,
        });
        return;
      }

      if (deployment.projectId !== workerGroup.projectId) {
        logger.error("[WorkerGroupTokenService] Deployment does not match worker group project", {
          deployment,
          workerGroup,
          workerInstance,
        });
        return;
      }

      if (deployment.status === "DEPLOYING") {
        // This is the first instance to be created for this deployment, so mark it as deployed
        await tx.workerDeployment.update({
          where: {
            id: deployment.id,
          },
          data: {
            status: "DEPLOYED",
            deployedAt: new Date(),
          },
        });

        // Check if the deployment should be promoted
        const workerPromotion = await tx.workerDeploymentPromotion.findFirst({
          where: {
            label: CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
            environmentId: deployment.environmentId,
          },
          include: {
            deployment: true,
          },
        });

        const shouldPromote =
          !workerPromotion || deployment.createdAt > workerPromotion.deployment.createdAt;

        if (shouldPromote) {
          // Promote the deployment
          await tx.workerDeploymentPromotion.upsert({
            where: {
              environmentId_label: {
                environmentId: deployment.environmentId,
                label: CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
              },
            },
            create: {
              deploymentId: deployment.id,
              environmentId: deployment.environmentId,
              label: CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
            },
            update: {
              deploymentId: deployment.id,
            },
          });
        }
      } else if (deployment.status !== "DEPLOYED") {
        logger.error("[WorkerGroupTokenService] Deployment not deploying or deployed", {
          deployment,
          workerGroup,
          workerInstance,
        });
        return;
      }

      const nonSharedWorkerInstance = tx.workerInstance.create({
        data: {
          workerGroupId: workerGroup.id,
          name: instanceName,
          resourceIdentifier,
          environmentId: deployment.environmentId,
          deploymentId: deployment.id,
        },
        include: {
          deployment: true,
          environment: {
            include: {
              parentEnvironment: true,
            },
          },
        },
      });

      return nonSharedWorkerInstance;
    });
  }

  private sanitizeHeaders(request: Request, skipHeaders = ["authorization"]) {
    const sanitizedHeaders: Partial<Record<string, string>> = {};

    for (const [key, value] of request.headers.entries()) {
      if (!skipHeaders.includes(key.toLowerCase())) {
        sanitizedHeaders[key] = value;
      }
    }

    return sanitizedHeaders;
  }
}

export const WorkerInstanceEnv = z.enum(["dev", "staging", "prod"]).default("prod");
export type WorkerInstanceEnv = z.infer<typeof WorkerInstanceEnv>;

type EnvironmentWithParent = RuntimeEnvironment & {
  parentEnvironment?: RuntimeEnvironment | null;
};

export type AuthenticatedWorkerInstanceOptions = WithRunEngineOptions<{
  type: WorkerInstanceGroupType;
  name: string;
  workerGroupId: string;
  workerInstanceId: string;
  masterQueue: string;
  environmentId?: string;
  deploymentId?: string;
  backgroundWorkerId?: string;
  runnerId?: string;
  environment: EnvironmentWithParent | null;
}>;

export class AuthenticatedWorkerInstance extends WithRunEngine {
  readonly type: WorkerInstanceGroupType;
  readonly name: string;
  readonly workerGroupId: string;
  readonly workerInstanceId: string;
  readonly runnerId?: string;
  readonly masterQueue: string;
  readonly environment: EnvironmentWithParent | null;
  readonly deploymentId?: string;
  readonly backgroundWorkerId?: string;

  // FIXME: Required for unmanaged workers
  readonly isLatestDeployment = true;

  constructor(opts: AuthenticatedWorkerInstanceOptions) {
    super({ prisma: opts.prisma, engine: opts.engine });

    this.type = opts.type;
    this.name = opts.name;
    this.workerGroupId = opts.workerGroupId;
    this.workerInstanceId = opts.workerInstanceId;
    this.masterQueue = opts.masterQueue;
    this.environment = opts.environment;
    this.deploymentId = opts.deploymentId;
    this.backgroundWorkerId = opts.backgroundWorkerId;
    this.runnerId = opts.runnerId;
  }

  async connect(metadata: Record<string, any>): Promise<void> {
    await this._prisma.workerInstance.update({
      where: {
        id: this.workerInstanceId,
      },
      data: {
        metadata,
      },
    });
  }

  async dequeue(): Promise<DequeuedMessage[]> {
    if (this.type === WorkerInstanceGroupType.MANAGED) {
      return await this._engine.dequeueFromWorkerQueue({
        consumerId: this.workerInstanceId,
        workerQueue: this.masterQueue,
        workerId: this.workerInstanceId,
        runnerId: this.runnerId,
      });
    }

    if (!this.environment || !this.deploymentId || !this.backgroundWorkerId) {
      logger.error("[AuthenticatedWorkerInstance] Missing environment or deployment", {
        ...this.toJSON(),
      });
      return [];
    }

    await this._prisma.workerInstance.update({
      where: {
        id: this.workerInstanceId,
      },
      data: {
        lastDequeueAt: new Date(),
      },
    });

    if (this.isLatestDeployment) {
      return await this._engine.dequeueFromEnvironmentWorkerQueue({
        consumerId: this.workerInstanceId,
        environmentId: this.environment.id,
        workerId: this.workerInstanceId,
        runnerId: this.runnerId,
      });
    }

    throw new ServiceValidationError("Unmanaged workers cannot dequeue from a specific version");
  }

  /** Allows managed workers to dequeue from a specific environment */
  async dequeueFromEnvironment(
    backgroundWorkerId: string,
    environmentId: string
  ): Promise<DequeuedMessage[]> {
    if (this.type !== WorkerInstanceGroupType.MANAGED) {
      logger.error("[AuthenticatedWorkerInstance] Worker instance is not managed", {
        ...this.toJSON(),
      });
      return [];
    }

    return await this._engine.dequeueFromEnvironmentWorkerQueue({
      consumerId: this.workerInstanceId,
      backgroundWorkerId,
      environmentId,
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });
  }

  async heartbeatWorkerInstance() {
    await this._prisma.workerInstance.update({
      where: {
        id: this.workerInstanceId,
      },
      data: {
        lastHeartbeatAt: new Date(),
      },
    });
  }

  async heartbeatRun({
    runFriendlyId,
    snapshotFriendlyId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
  }): Promise<ExecutionResult> {
    return await this._engine.heartbeatRun({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });
  }

  async startRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    isWarmStart,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    isWarmStart?: boolean;
  }): Promise<
    StartRunAttemptResult & {
      envVars: Record<string, string>;
    }
  > {
    const engineResult = await this._engine.startRunAttempt({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      isWarmStart,
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });

    const defaultMachinePreset = machinePresetFromName(defaultMachine);

    const environment =
      this.environment ??
      (await this._prisma.runtimeEnvironment.findFirst({
        where: {
          id: engineResult.execution.environment.id,
        },
        include: {
          parentEnvironment: true,
        },
      }));

    const envVars = environment
      ? await this.getEnvVars(
          environment,
          engineResult.run.id,
          engineResult.execution.machine ?? defaultMachinePreset,
          environment.parentEnvironment ?? undefined
        )
      : {};

    return {
      ...engineResult,
      envVars,
    };
  }

  async completeRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    completion,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    completion: TaskRunExecutionResult;
  }): Promise<CompleteRunAttemptResult> {
    return await this._engine.completeRunAttempt({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      completion,
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });
  }

  async getLatestSnapshot({ runFriendlyId }: { runFriendlyId: string }) {
    return await this._engine.getRunExecutionData({
      runId: fromFriendlyId(runFriendlyId),
    });
  }

  async createCheckpoint({
    runFriendlyId,
    snapshotFriendlyId,
    checkpoint,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    checkpoint: CheckpointInput;
  }) {
    return await this._engine.createCheckpoint({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      checkpoint,
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });
  }

  async continueRunExecution({
    runFriendlyId,
    snapshotFriendlyId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
  }) {
    return await this._engine.continueRunExecution({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      workerId: this.workerInstanceId,
      runnerId: this.runnerId,
    });
  }

  async getSnapshotsSince({
    runFriendlyId,
    snapshotId,
  }: {
    runFriendlyId: string;
    snapshotId: string;
  }) {
    return await this._engine.getSnapshotsSince({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotId),
    });
  }

  toJSON(): WorkerGroupTokenAuthenticationResponse {
    if (this.type === WorkerInstanceGroupType.MANAGED) {
      return {
        type: WorkerInstanceGroupType.MANAGED,
        name: this.name,
        workerGroupId: this.workerGroupId,
        workerInstanceId: this.workerInstanceId,
        masterQueue: this.masterQueue,
      };
    }

    return {
      type: WorkerInstanceGroupType.UNMANAGED,
      name: this.name,
      workerGroupId: this.workerGroupId,
      workerInstanceId: this.workerInstanceId,
      masterQueue: this.masterQueue,
      environmentId: this.environment?.id!,
      deploymentId: this.deploymentId!,
    };
  }

  private async getEnvVars(
    environment: RuntimeEnvironment,
    runId: string,
    machinePreset: MachinePreset,
    parentEnvironment?: RuntimeEnvironment
  ): Promise<Record<string, string>> {
    const variables = await resolveVariablesForEnvironment(environment, parentEnvironment);

    const jwt = await generateJWTTokenForEnvironment(environment, {
      run_id: runId,
      machine_preset: machinePreset.name,
    });

    variables.push(
      ...[
        { key: "TRIGGER_JWT", value: jwt },
        { key: "TRIGGER_RUN_ID", value: runId },
        { key: "TRIGGER_MACHINE_PRESET", value: machinePreset.name },
      ]
    );

    return variables.reduce((acc: Record<string, string>, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
  }
}

export type WorkerGroupTokenAuthenticationResponse =
  | {
      type: typeof WorkerInstanceGroupType.MANAGED;
      name: string;
      workerGroupId: string;
      workerInstanceId: string;
      masterQueue: string;
    }
  | {
      type: typeof WorkerInstanceGroupType.UNMANAGED;
      name: string;
      workerGroupId: string;
      workerInstanceId: string;
      masterQueue: string;
      environmentId: string;
      deploymentId: string;
    };
