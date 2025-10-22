import {
  ExternalBuildData,
  type FinalizeDeploymentRequestBody,
} from "@trigger.dev/core/v3/schemas";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { env } from "~/env.server";
import { depot as execDepot } from "@depot/cli";
import { FinalizeDeploymentService } from "./finalizeDeployment.server";
import { remoteBuildsEnabled } from "../remoteImageBuilder.server";
import { getEcrAuthToken, isEcrRegistry } from "../getDeploymentImageRef.server";
import { tryCatch } from "@trigger.dev/core";
import { getRegistryConfig, type RegistryConfig } from "../registryConfig.server";

export class FinalizeDeploymentV2Service extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody,
    writer?: WritableStreamDefaultWriter
  ) {
    // If remote builds are not enabled, lets just use the v1 finalize deployment service
    if (!remoteBuildsEnabled()) {
      const finalizeService = new FinalizeDeploymentService();
      return finalizeService.call(authenticatedEnv, id, body);
    }

    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        friendlyId: id,
        environmentId: authenticatedEnv.id,
      },
      select: {
        status: true,
        id: true,
        version: true,
        externalBuildData: true,
        environment: true,
        imageReference: true,
        type: true,
        worker: {
          select: {
            project: true,
          },
        },
      },
    });

    if (!deployment) {
      logger.error("Worker deployment not found", { id });
      return;
    }

    if (!deployment.worker) {
      logger.error("Worker deployment does not have a worker", { id });
      throw new ServiceValidationError("Worker deployment does not have a worker");
    }

    if (deployment.status === "DEPLOYED") {
      logger.debug("Worker deployment is already deployed", { id });

      return deployment;
    }

    if (deployment.status !== "DEPLOYING") {
      logger.error("Worker deployment is not in DEPLOYING status", { id });
      throw new ServiceValidationError("Worker deployment is not in DEPLOYING status");
    }

    const finalizeService = new FinalizeDeploymentService();

    if (body.skipPushToRegistry) {
      logger.debug("Skipping push to registry during deployment finalization", {
        deployment,
      });
      return await finalizeService.call(authenticatedEnv, id, body);
    }

    const externalBuildData = deployment.externalBuildData
      ? ExternalBuildData.safeParse(deployment.externalBuildData)
      : undefined;

    if (!externalBuildData) {
      throw new ServiceValidationError("External build data is missing");
    }

    if (!externalBuildData.success) {
      throw new ServiceValidationError("External build data is invalid");
    }

    const isV4Deployment = deployment.type === "MANAGED";
    const registryConfig = getRegistryConfig(isV4Deployment);

    // For non-ECR registries, username and password are required upfront
    if (
      !isEcrRegistry(registryConfig.host) &&
      (!registryConfig.username || !registryConfig.password)
    ) {
      throw new ServiceValidationError("Missing deployment registry credentials");
    }

    if (!env.DEPOT_TOKEN) {
      throw new ServiceValidationError("Missing depot token");
    }

    // All new deployments will set the image reference at creation time
    if (!deployment.imageReference) {
      throw new ServiceValidationError("Missing image reference");
    }

    logger.debug("Pushing image to registry", { id, deployment, body });

    const pushResult = await executePushToRegistry(
      {
        depot: {
          buildId: externalBuildData.data.buildId,
          orgToken: env.DEPOT_TOKEN,
          projectId: externalBuildData.data.projectId,
        },
        registry: registryConfig,
        deployment: {
          version: deployment.version,
          environmentSlug: deployment.environment.slug,
          projectExternalRef: deployment.worker.project.externalRef,
          imageReference: deployment.imageReference,
        },
      },
      writer
    );

    if (!pushResult.ok) {
      throw new ServiceValidationError(pushResult.error);
    }

    logger.debug("Image pushed to registry", {
      id,
      deployment,
      body,
      pushedImage: pushResult.image,
    });

    const finalizedDeployment = await finalizeService.call(authenticatedEnv, id, body);

    return finalizedDeployment;
  }
}

type ExecutePushToRegistryOptions = {
  depot: {
    buildId: string;
    orgToken: string;
    projectId: string;
  };
  registry: RegistryConfig;
  deployment: {
    version: string;
    environmentSlug: string;
    projectExternalRef: string;
    imageReference: string;
  };
};

type ExecutePushResult =
  | {
      ok: true;
      image: string;
      logs: string;
    }
  | {
      ok: false;
      error: string;
      logs: string;
    };

async function executePushToRegistry(
  { depot, registry, deployment }: ExecutePushToRegistryOptions,
  writer?: WritableStreamDefaultWriter
): Promise<ExecutePushResult> {
  // Step 1: We need to "login" to the registry
  const [loginError, configDir] = await tryCatch(ensureLoggedIntoDockerRegistry(registry));

  if (loginError) {
    logger.error("Failed to login to registry", {
      deployment,
      registryHost: registry.host,
      error: loginError.message,
    });

    return {
      ok: false as const,
      error: "Failed to login to registry",
      logs: "",
    };
  }

  const imageTag = deployment.imageReference;

  // Step 2: We need to run the depot push command
  const childProcess = execDepot(["push", depot.buildId, "-t", imageTag, "--progress", "plain"], {
    env: {
      NODE_ENV: process.env.NODE_ENV,
      DEPOT_TOKEN: depot.orgToken,
      DEPOT_PROJECT_ID: depot.projectId,
      DEPOT_NO_SUMMARY_LINK: "1",
      DEPOT_NO_UPDATE_NOTIFIER: "1",
      DOCKER_CONFIG: configDir,
    },
  });

  const errors: string[] = [];

  try {
    const processCode = await new Promise<number | null>((res, rej) => {
      // For some reason everything is output on stderr, not stdout
      childProcess.stderr?.on("data", async (data: Buffer) => {
        const text = data.toString();

        // Emitted data chunks can contain multiple lines. Remove empty lines.
        const lines = text.split("\n").filter(Boolean);

        errors.push(...lines);
        logger.debug(text, { deployment });

        // Now we can write strings directly
        if (writer) {
          for (const line of lines) {
            await writer.write(`event: log\ndata: ${JSON.stringify({ message: line })}\n\n`);
          }
        }
      });

      childProcess.on("error", (e) => rej(e));
      childProcess.on("close", (code) => res(code));
    });

    const logs = extractLogs(errors);

    if (processCode !== 0) {
      return {
        ok: false as const,
        error: `Error pushing image`,
        logs,
      };
    }

    return {
      ok: true as const,
      image: imageTag,
      logs,
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : JSON.stringify(e),
      logs: extractLogs(errors),
    };
  }
}

async function ensureLoggedIntoDockerRegistry(registryConfig: RegistryConfig) {
  const tmpDir = await createTempDir();
  const dockerConfigPath = join(tmpDir, "config.json");

  let auth: { username: string; password: string };

  // If this is an ECR registry, get fresh credentials
  if (isEcrRegistry(registryConfig.host)) {
    auth = await getEcrAuthToken({
      registryHost: registryConfig.host,
      assumeRole: registryConfig.ecrAssumeRoleArn
        ? {
            roleArn: registryConfig.ecrAssumeRoleArn,
            externalId: registryConfig.ecrAssumeRoleExternalId,
          }
        : undefined,
    });
  } else if (!registryConfig.username || !registryConfig.password) {
    throw new Error("Authentication required for non-ECR registry");
  } else {
    auth = {
      username: registryConfig.username,
      password: registryConfig.password,
    };
  }

  await writeJSONFile(dockerConfigPath, {
    auths: {
      [registryConfig.host]: {
        auth: Buffer.from(`${auth.username}:${auth.password}`).toString("base64"),
      },
    },
  });

  logger.debug(`Writing docker config to ${dockerConfigPath}`);

  return tmpDir;
}

// Create a temporary directory within the OS's temp directory
async function createTempDir(): Promise<string> {
  // Generate a unique temp directory path
  const tempDirPath: string = join(tmpdir(), "trigger-");

  // Create the temp directory synchronously and return the path
  const directory = await mkdtemp(tempDirPath);

  return directory;
}

async function writeJSONFile(path: string, json: any, pretty = false) {
  await writeFile(path, JSON.stringify(json, undefined, pretty ? 2 : undefined), "utf8");
}

function extractLogs(outputs: string[]) {
  // Remove empty lines
  const cleanedOutputs = outputs.map((line) => line.trim()).filter((line) => line !== "");

  return cleanedOutputs.map((line) => line.trim()).join("\n");
}
