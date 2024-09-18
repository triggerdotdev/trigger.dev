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

  // Non-self-hosted specific options
  loadImage?: boolean;

  // Flattened properties from nested structures
  registryHost: string;
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
  } = options;

  if (selfHosted) {
    return selfHostedBuildImage({
      registryHost: registryHost,
      imageTag: imageTag,
      cwd: compilationPath,
      projectId: projectId,
      deploymentId: deploymentId,
      deploymentVersion: deploymentVersion,
      contentHash: contentHash,
      projectRef: projectRef,
      buildPlatform: buildPlatform,
      pushImage: push,
      selfHostedRegistry: !!registry,
      noCache: noCache,
      extraCACerts: extraCACerts,
      apiUrl,
      apiKey,
      buildEnvVars,
    });
  }

  if (!externalBuildId || !externalBuildToken || !externalBuildProjectId) {
    throw new Error(
      "Failed to initialize deployment. The deployment does not have any external build data. To deploy this project, you must use the --self-hosted flag to build and push the image yourself."
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
}

type BuildImageSuccess = {
  ok: true;
  image: string;
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
    "-t",
    `${options.registryHost}/${options.imageTag}`,
    ".",
    "--push",
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
      image: options.imageTag,
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
  registryHost: string;
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
  }

  if (buildProcess.exitCode !== 0) {
    return {
      ok: false as const,
      error: "Error building image",
      logs: extractLogs(errors),
    };
  }

  digest = extractImageDigest(errors);

  if (options.selfHostedRegistry || options.pushImage) {
    const pushArgs = ["push", imageRef].filter(Boolean) as string[];

    logger.debug(`docker ${pushArgs.join(" ")}`);

    // Push the image
    const pushProcess = x("docker", pushArgs, {
      nodeOptions: { cwd: options.cwd },
    });

    for await (const line of pushProcess) {
      logger.debug(line);
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

const DEFAULT_PACKAGES = ["busybox", "ca-certificates", "dumb-init", "git", "openssl"];

export async function generateContainerfile(options: GenerateContainerfileOptions) {
  switch (options.runtime) {
    case "node": {
      return await generateNodeContainerfile(options);
    }
    case "bun": {
      return await generateBunContainerfile(options);
    }
  }
}

async function generateBunContainerfile(options: GenerateContainerfileOptions) {
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

  return `
FROM imbios/bun-node:22-debian AS base

${baseInstructions}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get --fix-broken install -y && apt-get install -y --no-install-recommends ${packages} && apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

USER bun
WORKDIR /app

${buildArgs}

${buildEnvVars}

COPY --chown=bun:bun package.json ./
RUN bun install --production --no-save

# Now copy all the files
# IMPORTANT: Do this after running npm install because npm i will wipe out the node_modules directory
COPY --chown=bun:bun . .

${postInstallCommands}

from build as indexer

USER bun
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
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \
    NODE_ENV=production

# Run the indexer
RUN bun run ${options.indexScript}

# Development or production stage builds upon the base stage
FROM base AS final

USER bun
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

# Copy the files from the build stage
COPY --from=build --chown=bun:bun /app ./

# Copy the index.json file from the indexer stage
COPY --from=indexer --chown=bun:bun /app/index.json ./

ENTRYPOINT [ "dumb-init", "node", "${options.entrypoint}" ]
CMD []
  `;
}

async function generateNodeContainerfile(options: GenerateContainerfileOptions) {
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

  return `
FROM node:21-bookworm-slim@sha256:99afef5df7400a8d118e0504576d32ca700de5034c4f9271d2ff7c91cc12d170 AS base

${baseInstructions}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get --fix-broken install -y && apt-get install -y --no-install-recommends ${packages} && apt-get clean && rm -rf /var/lib/apt/lists/*

FROM base AS build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

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

from build as indexer

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
    NODE_ENV=production \
    NODE_OPTIONS="--max_old_space_size=8192"

# Copy the files from the install stage
COPY --from=build --chown=node:node /app ./

# Copy the index.json file from the indexer stage
COPY --from=indexer --chown=node:node /app/index.json ./

ENTRYPOINT [ "dumb-init", "node", "${options.entrypoint}" ]
CMD []
  `;
}
