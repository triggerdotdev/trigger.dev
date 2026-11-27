import {
  ExternalBuildData,
  type FinalizeDeploymentRequestBody,
  machineImageTag,
} from "@trigger.dev/core/v3/schemas";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { env } from "~/env.server";
import { depot as execDepot } from "@depot/cli";
import { FinalizeDeploymentService, failRefusedDeployment } from "./finalizeDeployment.server";
import { gateDeployment, type DeploymentGateResult } from "../deploymentChecks.server";
import { remoteBuildsEnabled } from "../remoteImageBuilder.server";
import { getEcrAuthToken, isEcrRegistry } from "../getDeploymentImageRef.server";
import { tryCatch } from "@trigger.dev/core";
import { getRegistryConfig, type RegistryConfig } from "../registryConfig.server";
import { ecrImageExists } from "./verifyDeploymentImage.server";
import { computeOnlyEnabled, loadOrgFeatureFlags } from "~/v3/computeOnlyFlag.server";
import { type MachineImage, TemplatePrebuildService } from "./templatePrebuild.server";

export class FinalizeDeploymentV2Service extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody,
    writer?: WritableStreamDefaultWriter
  ) {
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
            id: true,
            project: true,
            metadata: true,
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

    // From the primary: initialize may have just set computeOnly, and the authenticated env's
    // flags come from a replica that can still miss it.
    const orgFeatureFlags = await loadOrgFeatureFlags(
      this._prisma,
      authenticatedEnv.organizationId
    );

    const deploymentDiagnostics = {
      id: deployment.id,
      friendlyId: id,
      status: deployment.status,
      version: deployment.version,
      imageReference: deployment.imageReference,
      type: deployment.type,
    };
    const finalizeOptions = {
      skipPromotion: body.skipPromotion,
      imageDigest: body.imageDigest,
      skipPushToRegistry: body.skipPushToRegistry,
    };

    const finalizeService = new FinalizeDeploymentService();

    // If remote builds are not enabled, skip image push and go straight to finalize
    if (!remoteBuildsEnabled() || body.skipPushToRegistry) {
      if (body.skipPushToRegistry) {
        logger.debug("Skipping push to registry during deployment finalization", {
          deployment: deploymentDiagnostics,
          finalizeOptions,
        });
      }

      // The CLI claims the image is already in the registry (local build, or a
      // self-hosted setup). Verify before promoting so we never mark a
      // deployment DEPLOYED when nothing was actually pushed.
      await this.#assertImagePullable(deployment, body);
      // Runs before the template build.
      const gate = await this.#gate(authenticatedEnv, deployment, id, body);
      const checkedBody = withCheckedDigest(body, gate);
      const machineImages = await this.#storeMachineImages(deployment, body);
      await this.#prebuildTemplate(
        deployment,
        id,
        checkedBody,
        computeOnlyEnabled(orgFeatureFlags),
        writer,
        machineImages
      );

      return finalizeService.call(authenticatedEnv, id, checkedBody, orgFeatureFlags, gate);
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

    logger.debug("Pushing image to registry", {
      deployment: deploymentDiagnostics,
      finalizeOptions,
    });

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
      deployment: deploymentDiagnostics,
      finalizeOptions,
      pushedImage: pushResult.image,
    });

    // Belt and suspenders: confirm the push actually landed before promoting.
    await this.#assertImagePullable(deployment, body);
    // Runs before the template build.
    const gate = await this.#gate(authenticatedEnv, deployment, id, body);
    const checkedBody = withCheckedDigest(body, gate);
    await this.#prebuildTemplate(
      deployment,
      id,
      checkedBody,
      computeOnlyEnabled(orgFeatureFlags),
      writer
    );

    return finalizeService.call(authenticatedEnv, id, checkedBody, orgFeatureFlags, gate);
  }

  /** Runs the finalize step; a refused deploy is failed here and the error thrown for the client. */
  async #gate(
    authenticatedEnv: AuthenticatedEnvironment,
    deployment: { id: string; imageReference: string | null; type: string | null },
    deploymentFriendlyId: string,
    body: FinalizeDeploymentRequestBody
  ): Promise<DeploymentGateResult> {
    const gate = await gateDeployment(
      {
        id: deployment.id,
        friendlyId: deploymentFriendlyId,
        imageReference: deployment.imageReference,
        type: deployment.type,
        organizationId: authenticatedEnv.organizationId,
        projectRef: authenticatedEnv.project.externalRef,
      },
      body.imageDigest
    );
    if (gate.kind === "refuse") {
      await failRefusedDeployment(this._prisma, authenticatedEnv, deploymentFriendlyId, gate.error);
    }
    return gate;
  }

  // Only local builds push machine images, each tagged next to the deployment's image. Verified,
  // then stored once: a repeated finalize with the same images keeps their template keys.
  async #storeMachineImages(
    deployment: { id: string; imageReference: string | null; type: string | null },
    body: FinalizeDeploymentRequestBody
  ): Promise<MachineImage[]> {
    const digests = Object.entries(body.machineImageDigests ?? {});
    if (!deployment.imageReference || digests.length === 0) {
      return [];
    }

    const machines: MachineImage[] = [];
    for (const [machineId, digest] of digests) {
      const tag = machineImageTag(deployment.imageReference, machineId);
      await this.#assertImagePullable(
        { ...deployment, imageReference: tag },
        { imageDigest: digest },
        `Machine "${machineId}" image`
      );
      machines.push({ machineId, imageReference: `${tag}@${digest}` });
    }

    await this._prisma.workerDeploymentMachine.createMany({
      data: machines.map((machine) => ({ ...machine, deploymentId: deployment.id })),
      skipDuplicates: true,
    });

    const stored = await this._prisma.workerDeploymentMachine.findMany({
      where: { deploymentId: deployment.id },
      select: { machineId: true, imageReference: true },
    });
    const same =
      stored.length === machines.length &&
      machines.every((machine) =>
        stored.some(
          (row) =>
            row.machineId === machine.machineId && row.imageReference === machine.imageReference
        )
      );
    if (!same) {
      throw new ServiceValidationError("This deployment was already finalized with other images");
    }
    return machines;
  }

  // Waits for the build when the deployment contains sandbox tasks or the org is compute-only;
  // the finalizer rejects it if no template was stored.
  async #prebuildTemplate(
    deployment: {
      id: string;
      imageReference: string | null;
      worker: { id: string; project: { id: string }; metadata: unknown } | null;
    },
    deploymentFriendlyId: string,
    body: FinalizeDeploymentRequestBody,
    computeOnly: boolean,
    writer?: WritableStreamDefaultWriter,
    machineImages?: MachineImage[]
  ): Promise<void> {
    if (!deployment.imageReference || !deployment.worker) {
      return;
    }

    const sandboxTask = await this._prisma.backgroundWorkerTask.findFirst({
      where: { workerId: deployment.worker.id, executionMode: "SANDBOX" },
      select: { slug: true },
    });

    await new TemplatePrebuildService(this._prisma).prebuild({
      projectId: deployment.worker.project.id,
      deploymentId: deployment.id,
      deploymentFriendlyId,
      imageReference: deployment.imageReference,
      imageDigest: body.imageDigest,
      workerMetadata: deployment.worker.metadata,
      writer,
      requireTemplate: sandboxTask !== null || computeOnly,
      workerId: deployment.worker.id,
      machineImages,
    });
  }

  async #assertImagePullable(
    deployment: { imageReference: string | null; type: string | null },
    body: Pick<FinalizeDeploymentRequestBody, "imageDigest">,
    imageName = "Deployment image"
  ): Promise<void> {
    if (!env.DEPLOY_IMAGE_VERIFICATION_ENABLED) {
      return;
    }

    if (!deployment.imageReference) {
      return;
    }

    const registryConfig = getRegistryConfig(deployment.type === "MANAGED");

    // ECR-only: non-ECR (self-hosted) registries can't be checked this way, so skip.
    if (!isEcrRegistry(registryConfig.host)) {
      return;
    }

    const result = await ecrImageExists({
      imageReference: deployment.imageReference,
      imageDigest: body.imageDigest,
      registryConfig,
    });

    if (result === "missing") {
      throw new ServiceValidationError(
        `${imageName} was not found in the registry. It may not have been pushed (for example a local build without a push, or a push to a different registry). Aborting the deploy to avoid promoting a version that cannot start.`
      );
    }

    if (result === "nonconformant") {
      throw new ServiceValidationError(
        `${imageName} is not runnable: it contains zstd-compressed layers inside a Docker (v2s2) manifest, which the container runtime cannot pull. This typically comes from an outdated CLI version. Please upgrade to the latest trigger.dev CLI and re-deploy.`
      );
    }

    // Fail closed: if we can't confirm the image is present, don't promote a version
    // that might not start. Set DEPLOY_IMAGE_VERIFICATION_ENABLED=0 for out-of-band pushes.
    if (result === "unknown") {
      throw new ServiceValidationError(
        `Could not verify that the ${imageName.toLowerCase()} exists in the registry. Aborting the deploy.`
      );
    }
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

/** The request with the resolved digest in place of the client's, when there is one. */
function withCheckedDigest(
  body: FinalizeDeploymentRequestBody,
  gate: DeploymentGateResult
): FinalizeDeploymentRequestBody {
  return gate.kind === "proceed" && gate.checked
    ? { ...body, imageDigest: gate.imageDigest }
    : body;
}
