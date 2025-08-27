import { createCache, DefaultStatefulContext, MemoryStore, Namespace } from "@internal/cache";
import {
  CheckpointInput,
  CompleteRunAttemptResult,
  DequeuedMessage,
  ExecutionResult,
  MachinePreset,
  StartRunAttemptResult,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { fromFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { WORKER_HEADERS } from "@trigger.dev/core/v3/workers";
import {
  Prisma,
  RuntimeEnvironment,
  WorkerInstanceGroup,
  WorkerInstanceGroupType,
} from "@trigger.dev/database";
import { createHash, timingSafeEqual } from "crypto";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { env } from "~/env.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { defaultMachine } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import { WithRunEngine, WithRunEngineOptions } from "../baseService.server";

const authenticatedWorkerInstanceCache = singleton(
  "authenticatedWorkerInstanceCache",
  createAuthenticatedWorkerInstanceCache
);

function createAuthenticatedWorkerInstanceCache() {
  return createCache({
    authenticatedWorkerInstance: new Namespace<AuthenticatedWorkerInstance>(
      new DefaultStatefulContext(),
      {
        stores: [new MemoryStore({ persistentMap: new Map() })],
        fresh: 60_000 * 10, // 10 minutes
        stale: 60_000 * 11, // 11 minutes
      }
    ),
  });
}

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

    const result = await authenticatedWorkerInstanceCache.authenticatedWorkerInstance.swr(
      `worker-group-token-${token}`,
      async () => {
        const workerGroup = await this.findWorkerGroup({ token });

        if (!workerGroup) {
          logger.warn("[WorkerGroupTokenService] Worker group not found", { token });
          return;
        }

        const workerInstance = await this.getOrCreateWorkerInstance({
          workerGroup,
          instanceName,
        });

        if (!workerInstance) {
          logger.error("[WorkerGroupTokenService] Unable to get or create worker instance", {
            workerGroup,
            instanceName,
          });
          return;
        }

        return new AuthenticatedWorkerInstance({
          prisma: this._prisma,
          engine: this._engine,
          type: WorkerInstanceGroupType.MANAGED,
          name: workerGroup.name,
          workerGroupId: workerGroup.id,
          workerInstanceId: workerInstance.id,
          masterQueue: workerGroup.masterQueue,
        });
      }
    );

    if (result.err) {
      logger.error("[WorkerGroupTokenService] Failed to authenticate worker instance", {
        error: result.err,
      });
      return;
    }

    return result.val;
  }

  private async getOrCreateWorkerInstance({
    workerGroup,
    instanceName,
  }: {
    workerGroup: WorkerInstanceGroup;
    instanceName: string;
  }) {
    const resourceIdentifier = instanceName;

    const workerInstance = await this._prisma.workerInstance.findFirst({
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

    try {
      const newWorkerInstance = await this._prisma.workerInstance.create({
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
            const existingWorkerInstance = await this._prisma.workerInstance.findFirst({
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
            });
            return;
          }
        }
      }
    }
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
}>;

export class AuthenticatedWorkerInstance extends WithRunEngine {
  readonly type: WorkerInstanceGroupType;
  readonly name: string;
  readonly workerGroupId: string;
  readonly workerInstanceId: string;
  readonly masterQueue: string;

  // FIXME: Required for unmanaged workers
  readonly isLatestDeployment = true;

  constructor(opts: AuthenticatedWorkerInstanceOptions) {
    super({ prisma: opts.prisma, engine: opts.engine });

    this.type = opts.type;
    this.name = opts.name;
    this.workerGroupId = opts.workerGroupId;
    this.workerInstanceId = opts.workerInstanceId;
    this.masterQueue = opts.masterQueue;
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

  async dequeue({ runnerId }: { runnerId?: string }): Promise<DequeuedMessage[]> {
    return await this._engine.dequeueFromWorkerQueue({
      consumerId: this.workerInstanceId,
      workerQueue: this.masterQueue,
      workerId: this.workerInstanceId,
      runnerId,
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
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    runnerId?: string;
  }): Promise<ExecutionResult> {
    return await this._engine.heartbeatRun({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      workerId: this.workerInstanceId,
      runnerId,
    });
  }

  async startRunAttempt({
    runFriendlyId,
    snapshotFriendlyId,
    isWarmStart,
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    isWarmStart?: boolean;
    runnerId?: string;
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
      runnerId,
    });

    const defaultMachinePreset = machinePresetFromName(defaultMachine);

    const environment = await this._prisma.runtimeEnvironment.findFirst({
      where: {
        id: engineResult.execution.environment.id,
      },
      include: {
        parentEnvironment: true,
      },
    });

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
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    completion: TaskRunExecutionResult;
    runnerId?: string;
  }): Promise<CompleteRunAttemptResult> {
    return await this._engine.completeRunAttempt({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      completion,
      workerId: this.workerInstanceId,
      runnerId,
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
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    checkpoint: CheckpointInput;
    runnerId?: string;
  }) {
    return await this._engine.createCheckpoint({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      checkpoint,
      workerId: this.workerInstanceId,
      runnerId,
    });
  }

  async continueRunExecution({
    runFriendlyId,
    snapshotFriendlyId,
    runnerId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    runnerId?: string;
  }) {
    return await this._engine.continueRunExecution({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      workerId: this.workerInstanceId,
      runnerId,
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
    return {
      type: WorkerInstanceGroupType.MANAGED,
      name: this.name,
      workerGroupId: this.workerGroupId,
      workerInstanceId: this.workerInstanceId,
      masterQueue: this.masterQueue,
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
