import { ExternalBuildData, FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { env } from "~/env.server";
import { depot as execDepot } from "@depot/cli";
import { FinalizeDeploymentService } from "./finalizeDeployment.server";

export class FinalizeDeploymentV2Service extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody
  ) {
    // if it's self hosted, lets just use the v1 finalize deployment service
    if (body.selfHosted) {
      const finalizeService = new FinalizeDeploymentService();

      return finalizeService.call(authenticatedEnv, id, body);
    }

    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        friendlyId: id,
        environmentId: authenticatedEnv.id,
      },
      include: {
        environment: true,
        worker: {
          include: {
            tasks: true,
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

    const externalBuildData = deployment.externalBuildData
      ? ExternalBuildData.safeParse(deployment.externalBuildData)
      : undefined;

    if (!externalBuildData) {
      throw new ServiceValidationError("External build data is missing");
    }

    if (!externalBuildData.success) {
      throw new ServiceValidationError("External build data is invalid");
    }

    if (
      !env.DEPLOY_REGISTRY_HOST ||
      !env.DEPLOY_REGISTRY_USERNAME ||
      !env.DEPLOY_REGISTRY_PASSWORD
    ) {
      throw new ServiceValidationError("Missing deployment registry credentials");
    }

    if (!env.DEPOT_TOKEN) {
      throw new ServiceValidationError("Missing depot token");
    }

    const pushResult = await executePushToRegistry({
      depot: {
        buildId: externalBuildData.data.buildId,
        orgToken: env.DEPOT_TOKEN,
        projectId: externalBuildData.data.projectId,
      },
      registry: {
        host: env.DEPLOY_REGISTRY_HOST,
        namespace: env.DEPLOY_REGISTRY_NAMESPACE,
        username: env.DEPLOY_REGISTRY_USERNAME,
        password: env.DEPLOY_REGISTRY_PASSWORD,
      },
      deployment: {
        version: deployment.version,
        environmentSlug: deployment.environment.slug,
        projectExternalRef: deployment.worker.project.externalRef,
      },
    });

    if (!pushResult.ok) {
      throw new ServiceValidationError(pushResult.error);
    }

    const finalizeService = new FinalizeDeploymentService();

    const finalizedDeployment = await finalizeService.call(authenticatedEnv, id, {
      imageReference: pushResult.image,
      skipRegistryProxy: true,
    });

    return finalizedDeployment;
  }
}

type ExecutePushToRegistryOptions = {
  depot: {
    buildId: string;
    orgToken: string;
    projectId: string;
  };
  registry: {
    host: string;
    namespace: string;
    username: string;
    password: string;
  };
  deployment: {
    version: string;
    environmentSlug: string;
    projectExternalRef: string;
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

async function executePushToRegistry({
  depot,
  registry,
  deployment,
}: ExecutePushToRegistryOptions): Promise<ExecutePushResult> {
  // Step 1: We need to "login" to the digital ocean registry
  const configDir = await ensureLoggedIntoDockerRegistry(registry.host, {
    username: registry.username,
    password: registry.password,
  });

  const imageTag = `${registry.host}/${registry.namespace}/${deployment.projectExternalRef}:${deployment.version}.${deployment.environmentSlug}`;

  // Step 2: We need to run the depot push command
  // DEPOT_TOKEN="<org token>" DEPOT_PROJECT_ID="<project id>" depot push <build id> -t registry.digitalocean.com/trigger-failover/proj_bzhdaqhlymtuhlrcgbqy:20250124.54.prod
  // Step 4: Build and push the image
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
      childProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();

        // Emitted data chunks can contain multiple lines. Remove empty lines.
        const lines = text.split("\n").filter(Boolean);

        errors.push(...lines);
        logger.debug(text, {
          imageTag,
          deployment,
        });
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

async function ensureLoggedIntoDockerRegistry(
  registryHost: string,
  auth: { username: string; password: string }
) {
  const tmpDir = await createTempDir();
  // Read the current docker config
  const dockerConfigPath = join(tmpDir, "config.json");

  await writeJSONFile(dockerConfigPath, {
    auths: {
      [registryHost]: {
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
