import { join } from "node:path";
import { createTempDir, writeJSONFile } from "../utilities/fileSystem.js";
import { logger } from "../utilities/logger.js";
import { depot } from "@depot/cli";
import { x } from "tinyexec";
import { BuildManifest, BuildRuntime } from "@trigger.dev/core/v3/schemas";

export interface BuildImageOptions {
  // Common options
  selfHosted: boolean;
  buildPlatform: string;
  noCache?: boolean;

  // Self-hosted specific options
  push: boolean;
  registry?: string;
  network?: string;

  // Non-self-hosted specific options
  loadImage?: boolean;

  // Flattened properties from nested structures
  registryHost?: string;
  authAccessToken: string;
  imageTag: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  externalBuildId?: string;
  externalBuildToken?: string;
  externalBuildProjectId?: string;
  compilationPath: string;
  projectId: string;
  projectRef: string;
  extraCACerts?: string;
  apiUrl: string;
  apiKey: string;
  buildEnvVars?: Record<string, string | undefined>;
  onLog?: (log: string) => void;

  // Optional deployment spinner
  deploymentSpinner?: any; // Replace 'any' with the actual type if known
}

export async function buildImage(options: BuildImageOptions) {
  const {
    selfHosted,
    buildPlatform,
    noCache,
    push,
    registry,
    loadImage,
    registryHost,
    authAccessToken,
    imageTag,
    deploymentId,
    deploymentVersion,
    contentHash,
    externalBuildId,
    externalBuildToken,
    externalBuildProjectId,
    compilationPath,
    projectId,
    projectRef,
    extraCACerts,
    apiUrl,
    apiKey,
    buildEnvVars,
    network,
    onLog,
  } = options;

  if (selfHosted) {
    return selfHostedBuildImage({
      registryHost,
      imageTag,
      cwd: compilationPath,
      projectId,
      deploymentId,
      deploymentVersion,
      contentHash,
      projectRef,
      buildPlatform: buildPlatform,
      pushImage: push,
      selfHostedRegistry: !!registry,
      noCache,
      extraCACerts,
      apiUrl,
      apiKey,
      buildEnvVars,
      network,
      onLog,
    });
  }

  if (!externalBuildId || !externalBuildToken || !externalBuildProjectId) {
    throw new Error(
      "Failed to initialize deployment. The deployment does not have any external build data. To deploy this project, you must use the --self-hosted flag to build and push the image yourself."
    );
  }

  if (!registryHost) {
    throw new Error(
      "Failed to initialize deployment. The deployment does not have a registry host. To deploy this project, you must use the --self-hosted or --local flag to build and push the image yourself."
    );
  }

  return depotBuildImage({
    registryHost,
    auth: authAccessToken,
    imageTag,
    buildId: externalBuildId,
    buildToken: externalBuildToken,
    buildProjectId: externalBuildProjectId,
    cwd: compilationPath,
    projectId,
    deploymentId,
    deploymentVersion,
    contentHash,
    projectRef,
    loadImage,
    buildPlatform,
    noCache,
    extraCACerts,
    apiUrl,
    apiKey,
    buildEnvVars,
    onLog,
  });
}

export interface DepotBuildImageOptions {
  registryHost: string;
  auth: string;
  imageTag: string;
  buildId: string;
  buildToken: string;
  buildProjectId: string;
  cwd: string;
  projectId: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  projectRef: string;
  buildPlatform: string;
  apiUrl: string;
  apiKey: string;
  loadImage?: boolean;
  noCache?: boolean;
  extraCACerts?: string;
  buildEnvVars?: Record<string, string | undefined>;
  onLog?: (log: string) => void;
}

type BuildImageSuccess = {
  ok: true;
  image: string;
  imageSizeBytes: number;
  logs: string;
  digest?: string;
};

type BuildImageFailure = {
  ok: false;
  error: string;
  logs: string;
};

type BuildImageResults = BuildImageSuccess | BuildImageFailure;

async function depotBuildImage(options: DepotBuildImageOptions): Promise<BuildImageResults> {
  // Step 3: Ensure we are "logged in" to our registry by writing to $HOME/.docker/config.json
  // TODO: make sure this works on windows
  const dockerConfigDir = await ensureLoggedIntoDockerRegistry(options.registryHost, {
    username: "trigger",
    password: options.auth,
  });

  const buildArgs = Object.entries(options.buildEnvVars || {})
    .filter(([key, value]) => value)
    .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

  const args = [
    "build",
    "-f",
    "Containerfile",
    options.noCache ? "--no-cache" : undefined,
    "--platform",
    options.buildPlatform,
    "--provenance",
    "false",
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_VERSION=${options.deploymentVersion}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "--build-arg",
    `TRIGGER_API_URL=${options.apiUrl}`,
    "--build-arg",
    `TRIGGER_SECRET_KEY=${options.apiKey}`,
    ...(buildArgs || []),
    ...(options.extraCACerts ? ["--build-arg", `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`] : []),
    "--progress",
    "plain",
    ".",
    "--save",
    options.loadImage ? "--load" : undefined,
  ].filter(Boolean) as string[];

  logger.debug(`depot ${args.join(" ")}`);

  // Step 4: Build and push the image
  const childProcess = depot(args, {
    cwd: options.cwd,
    env: {
      DEPOT_BUILD_ID: options.buildId,
      DEPOT_TOKEN: options.buildToken,
      DEPOT_PROJECT_ID: options.buildProjectId,
      DEPOT_NO_SUMMARY_LINK: "1",
      DEPOT_NO_UPDATE_NOTIFIER: "1",
      DOCKER_CONFIG: dockerConfigDir,
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

        for (const line of lines) {
          options.onLog?.(line);
        }

        errors.push(...lines);
        logger.debug(text);
      });

      childProcess.on("error", (e) => rej(e));
      childProcess.on("close", (code) => res(code));
    });

    const logs = extractLogs(errors);

    if (processCode !== 0) {
      return {
        ok: false as const,
        error: `Error building image`,
        logs,
      };
    }

    const digest = extractImageDigest(errors);

    return {
      ok: true as const,
      image: `registry.depot.dev/${options.buildProjectId}:${options.buildId}`,
      imageSizeBytes: 0,
      logs,
      digest,
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : JSON.stringify(e),
      logs: extractLogs(errors),
    };
  }
}

interface SelfHostedBuildImageOptions {
  registryHost?: string;
  imageTag: string;
  cwd: string;
  projectId: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  projectRef: string;
  buildPlatform: string;
  pushImage: boolean;
  selfHostedRegistry: boolean;
  apiUrl: string;
  apiKey: string;
  noCache?: boolean;
  extraCACerts?: string;
  buildEnvVars?: Record<string, string | undefined>;
  network?: string;
  onLog?: (log: string) => void;
}

async function selfHostedBuildImage(
  options: SelfHostedBuildImageOptions
): Promise<BuildImageResults> {
  const imageRef = `${options.registryHost ? `${options.registryHost}/` : ""}${options.imageTag}`;

  const buildArgs = Object.entries(options.buildEnvVars || {})
    .filter(([key, value]) => value)
    .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

  const args = [
    "build",
    "-f",
    "Containerfile",
    options.noCache ? "--no-cache" : undefined,
    "--platform",
    options.buildPlatform,
    ...(options.network ? ["--network", options.network] : []),
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_VERSION=${options.deploymentVersion}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "--build-arg",
    `TRIGGER_API_URL=${options.apiUrl}`,
    "--build-arg",
    `TRIGGER_SECRET_KEY=${options.apiKey}`,
    ...(buildArgs || []),
    ...(options.extraCACerts ? ["--build-arg", `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`] : []),
    "--progress",
    "plain",
    "-t",
    imageRef,
    ".", // The build context
  ].filter(Boolean) as string[];

  logger.debug(`docker ${args.join(" ")}`, {
    cwd: options.cwd,
  });

  const errors: string[] = [];
  let digest: string | undefined;

  // Build the image
  const buildProcess = x("docker", args, {
    nodeOptions: { cwd: options.cwd },
  });

  for await (const line of buildProcess) {
    // line will be from stderr/stdout in the order you'd see it in a term
    errors.push(line);
    logger.debug(line);
    options.onLog?.(line);
  }

  if (buildProcess.exitCode !== 0) {
    return {
      ok: false as const,
      error: "Error building image",
      logs: extractLogs(errors),
    };
  }

  digest = extractImageDigest(errors);

  // Get the image size
  const sizeProcess = x("docker", ["image", "inspect", imageRef, "--format={{.Size}}"], {
    nodeOptions: { cwd: options.cwd },
  });

  let imageSizeBytes = 0;
  for await (const line of sizeProcess) {
    if (line.trim() === "") {
      continue;
    }

    imageSizeBytes = parseInt(line, 10);
    break;
  }

  if (imageSizeBytes) {
    // Convert to MB and log
    options.onLog?.(`Image size: ${(imageSizeBytes / (1024 * 1024)).toFixed(2)} MB`);
  }

  if (options.selfHostedRegistry || options.pushImage) {
    const pushArgs = ["push", imageRef].filter(Boolean) as string[];

    logger.debug(`docker ${pushArgs.join(" ")}`);

    // Push the image
    const pushProcess = x("docker", pushArgs, {
      nodeOptions: { cwd: options.cwd },
    });

    for await (const line of pushProcess) {
      logger.debug(line);
      errors.push(line);
    }

    if (pushProcess.exitCode !== 0) {
      return {
        ok: false as const,
        error: "Error pushing image",
        logs: extractLogs(errors),
      };
    }
  }

  return {
    ok: true as const,
    image: options.imageTag,
    imageSizeBytes,
    digest,
    logs: extractLogs(errors),
  };
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

function extractLogs(outputs: string[]) {
  // Remove empty lines
  const cleanedOutputs = outputs.map((line) => line.trim()).filter((line) => line !== "");

  return cleanedOutputs.map((line) => line.trim()).join("\n");
}

function extractImageDigest(outputs: string[]) {
  const imageDigestRegex = /pushing manifest for .+(?<digest>sha256:[a-f0-9]{64})/;

  for (const line of outputs) {
    const imageDigestMatch = line.match(imageDigestRegex);

    const digest = imageDigestMatch?.groups?.digest;

    if (digest) {
      return digest;
    }
  }

  return;
}

export type GenerateContainerfileOptions = {
  runtime: BuildRuntime;
  build: BuildManifest["build"];
  image: BuildManifest["image"];
  indexScript: string;
  entrypoint: string;
};

const NODE_21_IMAGE =
  "node:21.7.3-bookworm-slim@sha256:dfc05dee209a1d7adf2ef189bd97396daad4e97c6eaa85778d6f75205ba1b0fb";

const NODE_TEST_IMAGE = NODE_21_IMAGE;

const BASE_IMAGE: Record<BuildRuntime, string> = {
  node: NODE_21_IMAGE,
  "node-test": NODE_TEST_IMAGE,
};

const DEFAULT_PACKAGES = ["busybox", "ca-certificates", "dumb-init", "git", "openssl"];

export async function generateContainerfile(options: GenerateContainerfileOptions) {
  switch (options.runtime) {
    case "node":
    case "node-test": {
      return await generateNodeContainerfile(options);
    }
  }
}

const parseGenerateOptions = (options: GenerateContainerfileOptions) => {
  const buildArgs = Object.entries(options.build.env || {})
    .flatMap(([key]) => `ARG ${key}`)
    .join("\n");

  const buildEnvVars = Object.entries(options.build.env || {})
    .flatMap(([key]) => `ENV ${key}=$${key}`)
    .join("\n");

  const postInstallCommands = (options.build.commands || []).map((cmd) => `RUN ${cmd}`).join("\n");

  const baseInstructions = (options.image?.instructions || []).join("\n");
  const packages = Array.from(new Set(DEFAULT_PACKAGES.concat(options.image?.pkgs || []))).join(
    " "
  );

  return {
    baseImage: BASE_IMAGE[options.runtime],
    baseInstructions,
    buildArgs,
    buildEnvVars,
    packages,
    postInstallCommands,
  };
};

async function generateNodeContainerfile(options: GenerateContainerfileOptions) {
  const { baseImage, buildArgs, buildEnvVars, postInstallCommands, baseInstructions, packages } =
    parseGenerateOptions(options);

  return `# syntax=docker/dockerfile:1
FROM ${baseImage} AS base

${baseInstructions}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
  apt-get --fix-broken install -y && \
  apt-get install -y --no-install-recommends ${packages} && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS build

# Install build dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /app

${buildArgs}

${buildEnvVars}

ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --chown=node:node package.json ./
RUN npm i --no-audit --no-fund --no-save --no-package-lock

# Now copy all the files
# IMPORTANT: Do this after running npm install because npm i will wipe out the node_modules directory
COPY --chown=node:node . .

${postInstallCommands}

# IMPORTANT: Doing this again to fix an issue with prisma generate removing the files in node_modules/trigger.dev for some reason...
COPY --chown=node:node . .

FROM build AS indexer

USER node
WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_DEPLOYMENT_ID
ARG TRIGGER_DEPLOYMENT_VERSION
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS
ARG TRIGGER_SECRET_KEY
ARG TRIGGER_API_URL

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_SECRET_KEY=\${TRIGGER_SECRET_KEY} \
    TRIGGER_API_URL=\${TRIGGER_API_URL} \
    TRIGGER_LOG_LEVEL=debug \
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \
    NODE_ENV=production \
    NODE_OPTIONS="--max_old_space_size=8192"

# Run the indexer
RUN node ${options.indexScript}

# Development or production stage builds upon the base stage
FROM base AS final

USER node
WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_DEPLOYMENT_ID
ARG TRIGGER_DEPLOYMENT_VERSION
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \
    NODE_ENV=production

# Copy the files from the install stage
COPY --from=build --chown=node:node /app ./

# Copy the index.json file from the indexer stage
COPY --from=indexer --chown=node:node /app/index.json ./

ENTRYPOINT [ "dumb-init", "node", "${options.entrypoint}" ]
CMD []
  `;
}
