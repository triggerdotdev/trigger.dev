import { customAlphabet } from "nanoid";
import { WithRunEngine, WithRunEngineOptions } from "../baseService.server";
import { createHash } from "crypto";
import { logger } from "~/services/logger.server";
import { WorkerInstanceGroup, WorkerInstanceGroupType } from "@trigger.dev/database";
import { z } from "zod";
import { HEADER_NAME } from "@trigger.dev/worker";
import { DequeuedMessage } from "@internal/run-engine/engine/messages";

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

    const workerGroupToken = await this._prisma.workerGroupToken.findFirst({
      where: {
        workerGroup: {
          isNot: null,
        },
        tokenHash,
      },
      include: {
        workerGroup: true,
      },
    });

    if (!workerGroupToken) {
      logger.warn("[WorkerGroupTokenService] Token not found", { token });
      return;
    }

    return workerGroupToken.workerGroup;
  }

  async rotateToken({ workerGroupId }: { workerGroupId: string }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
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

    const instanceName = request.headers.get(HEADER_NAME.WORKER_INSTANCE_NAME);

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

    const workerInstance = await this.getOrCreateWorkerInstance({
      workerGroup,
      instanceName,
      deploymentId: request.headers.get(HEADER_NAME.WORKER_DEPLOYMENT_ID) ?? undefined,
    });

    if (!workerInstance) {
      logger.error("[WorkerGroupTokenService] Unable to get or create worker instance", {
        workerGroup,
        instanceName,
      });
      return;
    }

    if (workerGroup.type === WorkerInstanceGroupType.SHARED) {
      return new AuthenticatedWorkerInstance({
        prisma: this._prisma,
        engine: this._engine,
        type: WorkerInstanceGroupType.SHARED,
        workerGroupId: workerGroup.id,
        workerInstanceId: workerInstance.id,
        masterQueue: workerGroup.masterQueue,
      });
    }

    if (!workerInstance.environmentId) {
      logger.error(
        "[WorkerGroupTokenService] Non-shared worker instance not linked to environment",
        { workerGroup, workerInstance }
      );
      return;
    }

    if (!workerInstance.deployment) {
      logger.error(
        "[WorkerGroupTokenService] Non-shared worker instance not linked to deployment",
        { workerGroup, workerInstance }
      );
      return;
    }

    if (!workerInstance.deployment.workerId) {
      logger.error(
        "[WorkerGroupTokenService] Non-shared worker instance deployment not linked to background worker",
        { workerGroup, workerInstance }
      );
      return;
    }

    return new AuthenticatedWorkerInstance({
      prisma: this._prisma,
      engine: this._engine,
      type: WorkerInstanceGroupType.UNMANAGED,
      workerGroupId: workerGroup.id,
      workerInstanceId: workerInstance.id,
      masterQueue: workerGroup.masterQueue,
      environmentId: workerInstance.environmentId,
      deploymentId: workerInstance.deployment.id,
      backgroundWorkerId: workerInstance.deployment.workerId,
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
    const workerInstance = await this._prisma.workerInstance.findUnique({
      where: {
        workerGroupId_name: {
          workerGroupId: workerGroup.id,
          name: instanceName,
        },
      },
      include: {
        deployment: true,
      },
    });

    if (workerInstance) {
      return workerInstance;
    }

    if (workerGroup.type === WorkerInstanceGroupType.SHARED) {
      return this._prisma.workerInstance.create({
        data: {
          workerGroupId: workerGroup.id,
          name: instanceName,
        },
        include: {
          deployment: true,
        },
      });
    }

    if (!workerGroup.projectId || !workerGroup.organizationId) {
      logger.error(
        "[WorkerGroupTokenService] Non-shared worker group missing project or organization",
        workerGroup
      );
      return;
    }

    // Unmanaged workers instances are locked to a specific deployment version

    const deployment = await this._prisma.workerDeployment.findUnique({
      where: {
        id: deploymentId,
      },
    });

    if (!deployment) {
      logger.error("[WorkerGroupTokenService] Deployment not found", { deploymentId });
      return;
    }

    if (deployment.projectId !== workerGroup.projectId) {
      logger.error("[WorkerGroupTokenService] Deployment does not match worker group project", {
        deployment,
        workerGroup,
      });
      return;
    }

    const nonSharedWorkerInstance = this._prisma.workerInstance.create({
      data: {
        workerGroupId: workerGroup.id,
        name: instanceName,
        environmentId: deployment.environmentId,
        deploymentId: deployment.id,
      },
      include: {
        deployment: true,
      },
    });

    return nonSharedWorkerInstance;
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
  workerGroupId: string;
  workerInstanceId: string;
  masterQueue: string;
  environmentId?: string;
  deploymentId?: string;
  backgroundWorkerId?: string;
}>;

export class AuthenticatedWorkerInstance extends WithRunEngine {
  readonly type: WorkerInstanceGroupType;
  readonly workerGroupId: string;
  readonly workerInstanceId: string;
  readonly masterQueue: string;
  readonly environmentId?: string;
  readonly deploymentId?: string;
  readonly backgroundWorkerId?: string;

  // FIXME
  readonly isLatestDeployment = true;

  constructor(opts: AuthenticatedWorkerInstanceOptions) {
    super({ prisma: opts.prisma, engine: opts.engine });

    this.type = opts.type;
    this.workerGroupId = opts.workerGroupId;
    this.workerInstanceId = opts.workerInstanceId;
    this.masterQueue = opts.masterQueue;
    this.environmentId = opts.environmentId;
    this.deploymentId = opts.deploymentId;
    this.backgroundWorkerId = opts.backgroundWorkerId;
  }

  async dequeue(maxRunCount = 10): Promise<DequeuedMessage[]> {
    if (this.type === WorkerInstanceGroupType.SHARED) {
      return await this._engine.dequeueFromMasterQueue({
        consumerId: this.workerInstanceId,
        masterQueue: this.masterQueue,
        maxRunCount,
      });
    }

    if (!this.environmentId || !this.deploymentId || !this.backgroundWorkerId) {
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
      return await this._engine.dequeueFromEnvironmentMasterQueue({
        consumerId: this.workerInstanceId,
        environmentId: this.environmentId,
        maxRunCount,
      });
    }

    return await this._engine.dequeueFromBackgroundWorkerMasterQueue({
      consumerId: this.workerInstanceId,
      backgroundWorkerId: this.deploymentId,
      maxRunCount,
    });
  }

  async heartbeat() {
    await this._prisma.workerInstance.update({
      where: {
        id: this.workerInstanceId,
      },
      data: {
        lastHeartbeatAt: new Date(),
      },
    });
  }

  toJSON(): WorkerGroupTokenAuthenticationResponse {
    if (this.type === WorkerInstanceGroupType.SHARED) {
      return {
        type: WorkerInstanceGroupType.SHARED,
        workerGroupId: this.workerGroupId,
        workerInstanceId: this.workerInstanceId,
        masterQueue: this.masterQueue,
      };
    }

    return {
      type: WorkerInstanceGroupType.UNMANAGED,
      workerGroupId: this.workerGroupId,
      workerInstanceId: this.workerInstanceId,
      masterQueue: this.masterQueue,
      environmentId: this.environmentId!,
      deploymentId: this.deploymentId!,
    };
  }
}

export type WorkerGroupTokenAuthenticationResponse =
  | {
      type: typeof WorkerInstanceGroupType.SHARED;
      workerGroupId: string;
      workerInstanceId: string;
      masterQueue: string;
    }
  | {
      type: typeof WorkerInstanceGroupType.UNMANAGED;
      workerGroupId: string;
      workerInstanceId: string;
      masterQueue: string;
      environmentId: string;
      deploymentId: string;
    };
