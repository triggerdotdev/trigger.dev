import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import type {
  CheckpointInput,
  CompleteRunAttemptResult,
  DequeuedMessage,
  ExecutionResult,
  MachinePreset,
  StartRunAttemptResult,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { fromFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { WORKER_HEADERS, type WorkerQueueClass } from "@trigger.dev/core/v3/workers";
import type { RuntimeEnvironment, WorkerInstanceGroup } from "@trigger.dev/database";
import { Prisma, WorkerInstanceGroupType } from "@trigger.dev/database";
import { json } from "@remix-run/server-runtime";
import { createHash, timingSafeEqual } from "crypto";
import { customAlphabet } from "nanoid";
import { Counter } from "prom-client";
import { z } from "zod";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { evaluateCreatedAtGate } from "./workloadTokenAuthorization.server";
import {
  isWorkerQueueDequeueDisabled,
  recordBlockedDequeue,
} from "~/runEngine/concerns/dequeueGate.server";
import { workerQueueForClass } from "~/runEngine/concerns/workerQueueSplit.server";
import { generateJWTTokenForEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { defaultMachine } from "~/services/platform.v3.server";
import { singleton } from "~/utils/singleton";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { machinePresetFromName } from "~/v3/machinePresets.server";
import type { WithRunEngineOptions } from "../baseService.server";
import { WithRunEngine } from "../baseService.server";

const authenticatedWorkerInstanceCache = singleton(
  "authenticatedWorkerInstanceCache",
  createAuthenticatedWorkerInstanceCache
);

// Opt-in suppression of untokened worker actions on runs created after the cutoff. Only the
// no-header path ever reads a run row, and only when this is on - default off means feature-off is
// byte-for-byte today's behavior (no extra reads). Tenant scoping itself is header-driven (folded
// into the engine snapshot read) and needs no platform flag.
const workloadCreatedAtGateEnabled = env.WORKLOAD_CREATED_AT_GATE_ENABLED === "1";
const workloadTokenCutoff = env.WORKLOAD_TOKEN_CUTOFF
  ? new Date(env.WORKLOAD_TOKEN_CUTOFF)
  : undefined;

if (workloadCreatedAtGateEnabled && !workloadTokenCutoff) {
  logger.warn(
    "WORKLOAD_CREATED_AT_GATE_ENABLED is set but WORKLOAD_TOKEN_CUTOFF is missing; the created-at gate stays off until a cutoff is configured"
  );
}

type WorkloadGateAction = "start" | "complete" | "continue" | "snapshots_since";

// singleton: module-scope registration double-registers under dev HMR
const workloadAuthGateCounter = singleton(
  "workloadAuthGateCounter",
  () =>
    new Counter({
      name: "workload_auth_gate_total",
      help: "Deployment token authorization outcomes on worker actions",
      labelNames: ["outcome", "action"] as const,
      registers: [metricsRegister],
    })
);

function createAuthenticatedWorkerInstanceCache() {
  return createCache({
    authenticatedWorkerInstance: new Namespace<AuthenticatedWorkerInstance>(
      new DefaultStatefulContext(),
      {
        stores: [createLRUMemoryStore(1000)],
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

    const cacheKey = ["worker-group-token", token, instanceName];

    const result = await authenticatedWorkerInstanceCache.authenticatedWorkerInstance.swr(
      cacheKey.join("-"),
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
          } catch (_error) {
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

  async dequeue({
    runnerId,
    queueClass,
  }: {
    runnerId?: string;
    queueClass?: WorkerQueueClass;
  }): Promise<DequeuedMessage[]> {
    const workerQueue = workerQueueForClass(this.masterQueue, queueClass);

    if (isWorkerQueueDequeueDisabled(workerQueue)) {
      recordBlockedDequeue(workerQueue);
      return [];
    }

    return await this._engine.dequeueFromWorkerQueue({
      consumerId: this.workerInstanceId,
      workerQueue,
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

  /**
   * The no-header fallback. When the env header is present the engine scopes the snapshot read by it
   * (nothing to do here). When it's absent, this optionally suppresses runs created after the cutoff -
   * a run that new enough should have carried a token, so a missing one is treated as out-of-scope.
   * Only runs when the gate is enabled AND a cutoff is set; that's the ONLY path that reads a run row.
   */
  private async assertCreatedAtGate({
    runId,
    environmentId,
    action,
  }: {
    runId: string;
    environmentId?: string;
    action: WorkloadGateAction;
  }): Promise<void> {
    if (environmentId) {
      // Scoping is delegated to the engine snapshot read; no run-row read here. Recorded so the
      // platform can see how much traffic is env-scoped as enforcement rolls out.
      workloadAuthGateCounter.inc({ outcome: "env_scoped", action });
      return;
    }

    if (!workloadCreatedAtGateEnabled || !workloadTokenCutoff) {
      return;
    }

    const run = await this._engine.runStore.findRun({ id: runId }, { select: { createdAt: true } });

    if (!run) {
      // Let the engine method surface the canonical not-found error.
      return;
    }

    const { allow, outcome } = evaluateCreatedAtGate({
      runCreatedAt: run.createdAt,
      cutoff: workloadTokenCutoff,
    });

    workloadAuthGateCounter.inc({ outcome, action });

    if (!allow) {
      logger.warn("[workload-auth] rejecting untokened worker action created after cutoff", {
        action,
        runId,
      });
      throw json({ error: "Run does not belong to this worker" }, { status: 403 });
    }
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
    environmentId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    isWarmStart?: boolean;
    runnerId?: string;
    environmentId?: string;
  }): Promise<
    StartRunAttemptResult & {
      envVars: Record<string, string>;
    }
  > {
    await this.assertCreatedAtGate({
      runId: fromFriendlyId(runFriendlyId),
      environmentId,
      action: "start",
    });

    const engineResult = await this._engine.startRunAttempt({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      isWarmStart,
      workerId: this.workerInstanceId,
      runnerId,
      environmentId,
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
          environment.parentEnvironment ?? undefined,
          engineResult.run.taskEventStore ?? undefined
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
    environmentId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    completion: TaskRunExecutionResult;
    runnerId?: string;
    environmentId?: string;
  }): Promise<CompleteRunAttemptResult> {
    await this.assertCreatedAtGate({
      runId: fromFriendlyId(runFriendlyId),
      environmentId,
      action: "complete",
    });

    return await this._engine.completeRunAttempt({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      completion,
      workerId: this.workerInstanceId,
      runnerId,
      environmentId,
    });
  }

  async getLatestSnapshot({
    runFriendlyId,
    environmentId,
  }: {
    runFriendlyId: string;
    environmentId?: string;
  }) {
    // No created-at gate: the only untokened caller is an internal warm-start poll that legitimately
    // has no token, so an absent header must not reject. When a header is present the engine scopes.
    return await this._engine.getRunExecutionData({
      runId: fromFriendlyId(runFriendlyId),
      environmentId,
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
    environmentId,
  }: {
    runFriendlyId: string;
    snapshotFriendlyId: string;
    runnerId?: string;
    environmentId?: string;
  }) {
    await this.assertCreatedAtGate({
      runId: fromFriendlyId(runFriendlyId),
      environmentId,
      action: "continue",
    });

    return await this._engine.continueRunExecution({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotFriendlyId),
      workerId: this.workerInstanceId,
      runnerId,
      environmentId,
    });
  }

  async getSnapshotsSince({
    runFriendlyId,
    snapshotId,
    environmentId,
  }: {
    runFriendlyId: string;
    snapshotId: string;
    environmentId?: string;
  }) {
    await this.assertCreatedAtGate({
      runId: fromFriendlyId(runFriendlyId),
      environmentId,
      action: "snapshots_since",
    });

    return await this._engine.getSnapshotsSince({
      runId: fromFriendlyId(runFriendlyId),
      snapshotId: fromFriendlyId(snapshotId),
      environmentId,
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
    parentEnvironment?: RuntimeEnvironment,
    taskEventStore?: string
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

    if (taskEventStore) {
      const resourceAttributes = JSON.stringify({
        [SemanticInternalAttributes.TASK_EVENT_STORE]: taskEventStore,
      });

      variables.push(
        ...[
          { key: "OTEL_RESOURCE_ATTRIBUTES", value: resourceAttributes },
          { key: "TRIGGER_OTEL_RESOURCE_ATTRIBUTES", value: resourceAttributes },
        ]
      );
    }

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
