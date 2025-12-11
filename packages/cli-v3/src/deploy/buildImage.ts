import { logger } from "../utilities/logger.js";
import { depot } from "@depot/cli";
import { x } from "tinyexec";
import { BuildManifest, BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { networkInterfaces } from "os";
import { join } from "path";
import { safeReadJSONFile } from "../utilities/fileSystem.js";
import { readFileSync } from "fs";

import { isLinux } from "std-env";
import { z } from "zod";
import { assertExhaustive } from "../utilities/assertExhaustive.js";
import { tryCatch } from "@trigger.dev/core";
import { CliApiClient } from "../apiClient.js";

export interface BuildImageOptions {
  // Common options
  isLocalBuild: boolean;
  useRegistryCache?: boolean;
  imagePlatform: string;
  noCache?: boolean;
  load?: boolean;

  // Local build options
  push?: boolean;
  authenticateToRegistry?: boolean;
  network?: string;
  builder: string;

  // Flattened properties from nested structures
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
  apiClient: CliApiClient;
  branchName?: string;
  buildEnvVars?: Record<string, string | undefined>;
  onLog?: (log: string) => void;

  // Optional deployment spinner
  deploymentSpinner?: any; // Replace 'any' with the actual type if known
}

export async function buildImage(options: BuildImageOptions): Promise<BuildImageResults> {
  const {
    isLocalBuild,
    useRegistryCache,
    imagePlatform,
    noCache,
    push,
    authenticateToRegistry,
    load,
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
    apiClient,
    branchName,
    buildEnvVars,
    network,
    builder,
    onLog,
  } = options;

  if (isLocalBuild) {
    return localBuildImage({
      imageTag,
      imagePlatform,
      cwd: compilationPath,
      projectId,
      deploymentId,
      deploymentVersion,
      contentHash,
      projectRef,
      push,
      authenticateToRegistry,
      load,
      noCache,
      useRegistryCache,
      extraCACerts,
      apiUrl,
      apiKey,
      apiClient,
      branchName,
      buildEnvVars,
      network,
      builder,
      onLog,
    });
  }

  if (!externalBuildId || !externalBuildToken || !externalBuildProjectId) {
    throw new Error(
      "Failed to initialize deployment. The deployment does not have any external build data. To deploy this project, you must use the --self-hosted flag to build and push the image yourself."
    );
  }

  return remoteBuildImage({
    auth: authAccessToken,
    buildId: externalBuildId,
    buildToken: externalBuildToken,
    buildProjectId: externalBuildProjectId,
    cwd: compilationPath,
    projectId,
    deploymentId,
    deploymentVersion,
    contentHash,
    projectRef,
    load,
    imagePlatform,
    noCache,
    extraCACerts,
    apiUrl,
    apiKey,
    branchName,
    buildEnvVars,
    onLog,
  });
}

export interface DepotBuildImageOptions {
  auth: string;
  buildId: string;
  buildToken: string;
  buildProjectId: string;
  cwd: string;
  projectId: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  projectRef: string;
  imagePlatform: string;
  apiUrl: string;
  apiKey: string;
  branchName?: string;
  load?: boolean;
  noCache?: boolean;
  extraCACerts?: string;
  buildEnvVars?: Record<string, string | undefined>;
  onLog?: (log: string) => void;
}

type BuildImageSuccess = {
  ok: true;
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

async function remoteBuildImage(options: DepotBuildImageOptions): Promise<BuildImageResults> {
  const buildArgs = Object.entries(options.buildEnvVars || {})
    .filter(([key, value]) => value)
    .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

  const args = [
    "build",
    "-f",
    "Containerfile",
    options.noCache ? "--no-cache" : undefined,
    "--platform",
    options.imagePlatform,
    options.load ? "--load" : undefined,
    "--provenance",
    "false",
    "--metadata-file",
    "metadata.json",
    "--build-arg",
    `SOURCE_DATE_EPOCH=0`,
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "--build-arg",
    `TRIGGER_API_URL=${options.apiUrl}`,
    "--build-arg",
    `TRIGGER_PREVIEW_BRANCH=${options.branchName ?? ""}`,
    "--build-arg",
    `TRIGGER_SECRET_KEY=${options.apiKey}`,
    ...(buildArgs || []),
    ...(options.extraCACerts ? ["--build-arg", `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`] : []),
    "--output",
    "type=image,rewrite-timestamp=true",
    "--progress",
    "plain",
    ".",
    "--save",
  ].filter(Boolean) as string[];

  logger.debug(`depot ${args.join(" ")}`, { cwd: options.cwd });

  // Step 4: Build and push the image
  const childProcess = depot(args, {
    cwd: options.cwd,
    env: {
      DEPOT_BUILD_ID: options.buildId,
      DEPOT_TOKEN: options.buildToken,
      DEPOT_PROJECT_ID: options.buildProjectId,
      DEPOT_NO_SUMMARY_LINK: "1",
      DEPOT_NO_UPDATE_NOTIFIER: "1",
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

    const metadataPath = join(options.cwd, "metadata.json");
    const rawMetadata = await safeReadJSONFile(metadataPath);

    const meta = BuildKitMetadata.safeParse(rawMetadata);

    let digest: string | undefined;
    if (!meta.success) {
      logger.error("Failed to parse metadata.json", {
        errors: meta.error.message,
        path: metadataPath,
      });
    } else {
      logger.debug("Parsed metadata.json", { metadata: meta.data, path: metadataPath });
      digest = meta.data["containerimage.digest"];
    }

    return {
      ok: true as const,
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
  imageTag: string;
  cwd: string;
  projectId: string;
  deploymentId: string;
  deploymentVersion: string;
  contentHash: string;
  projectRef: string;
  imagePlatform: string;
  push?: boolean;
  authenticateToRegistry?: boolean;
  apiUrl: string;
  apiKey: string;
  apiClient: CliApiClient;
  branchName?: string;
  noCache?: boolean;
  useRegistryCache?: boolean;
  extraCACerts?: string;
  buildEnvVars?: Record<string, string | undefined>;
  network?: string;
  builder: string;
  load?: boolean;
  onLog?: (log: string) => void;
}

async function localBuildImage(options: SelfHostedBuildImageOptions): Promise<BuildImageResults> {
  const { builder, imageTag, deploymentId, apiClient, useRegistryCache } = options;

  // Ensure multi-platform build is supported on the local machine
  let builderExists = false;
  const lsLogs: string[] = [];

  // List existing builders
  const lsProcess = x("docker", ["buildx", "ls", "--format", "{{.Name}}"]);
  for await (const line of lsProcess) {
    lsLogs.push(line);
    logger.debug(line);

    if (line === builder) {
      builderExists = true;
    }
  }
  if (lsProcess.exitCode !== 0) {
    return {
      ok: false as const,
      error: `Failed to list buildx builders`,
      logs: lsLogs.join("\n"),
    };
  }

  if (builderExists && options.network) {
    // We need to ensure the current builder network matches
    const inspectProcess = x("docker", ["buildx", "inspect", builder]);
    const inspectLogs: string[] = [];

    let hasCorrectNetwork = false;
    for await (const line of inspectProcess) {
      inspectLogs.push(line);

      if (line.match(/Driver Options:\s+network="([^"]+)"/)?.at(1) === options.network) {
        hasCorrectNetwork = true;
      }
    }

    if (inspectProcess.exitCode !== 0) {
      return {
        ok: false as const,
        error: `Failed to inspect buildx builder '${builder}'`,
        logs: inspectLogs.join("\n"),
      };
    }

    if (!hasCorrectNetwork) {
      // Delete the existing builder and signal to create a new one
      const deleteProcess = x("docker", ["buildx", "rm", builder]);
      const deleteLogs: string[] = [];

      for await (const line of deleteProcess) {
        deleteLogs.push(line);
      }

      if (deleteProcess.exitCode !== 0) {
        return {
          ok: false as const,
          error: `Failed to delete buildx builder '${builder}'`,
          logs: deleteLogs.join("\n"),
        };
      }

      builderExists = false;
    }
  }

  // If the builder does not exist, create it and is compatible with multi-platform builds
  if (!builderExists) {
    const createLogs: string[] = [];

    const args = (
      [
        "buildx",
        "create",
        "--name",
        builder,
        "--driver",
        "docker-container",
        options.network ? `--driver-opt=network=${options.network}` : undefined,
      ] satisfies (string | undefined)[]
    ).filter(Boolean) as string[];

    const createProcess = x("docker", args);
    for await (const line of createProcess) {
      createLogs.push(line);
      logger.debug(line);
      options.onLog?.(line);
    }
    if (createProcess.exitCode !== 0) {
      return {
        ok: false as const,
        error: `Failed to create buildx builder '${builder}'`,
        logs: [...lsLogs, ...createLogs].join("\n"),
      };
    }
  }

  const buildArgs = Object.entries(options.buildEnvVars || {})
    .filter(([key, value]) => value)
    .flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

  const apiUrl = normalizeApiUrlForBuild(options.apiUrl);
  const addHost = getAddHost(apiUrl);
  const push = shouldPush(options.imageTag, options.push);
  const load = shouldLoad(options.load, push);

  await ensureQemuRegistered(options.imagePlatform);

  const errors: string[] = [];

  let cloudRegistryHost: string | undefined;
  if (push && options.authenticateToRegistry) {
    cloudRegistryHost =
      process.env.TRIGGER_DOCKER_REGISTRY ?? extractRegistryHostFromImageTag(imageTag);

    if (!cloudRegistryHost) {
      return {
        ok: false as const,
        error: "Failed to extract registry host from image tag",
        logs: "",
      };
    }

    const [credentialsError, credentials] = await tryCatch(
      getDockerUsernameAndPassword(apiClient, deploymentId)
    );

    if (credentialsError) {
      return {
        ok: false as const,
        error: `Failed to get docker credentials: ${credentialsError.message}`,
        logs: "",
      };
    }

    logger.debug(`Logging in to docker registry: ${cloudRegistryHost}`);

    const loginProcess = x(
      "docker",
      ["login", "--username", credentials.username, "--password-stdin", cloudRegistryHost],
      {
        nodeOptions: {
          cwd: options.cwd,
        },
      }
    );

    loginProcess.process?.stdin?.write(credentials.password);
    loginProcess.process?.stdin?.end();

    for await (const line of loginProcess) {
      errors.push(line);
      logger.debug(line);
    }

    if (loginProcess.exitCode !== 0) {
      return {
        ok: false as const,
        error: `Failed to login to registry: ${cloudRegistryHost}`,
        logs: extractLogs(errors),
      };
    }

    options.onLog?.(`Successfully logged in to the remote registry`);
  }

  const projectCacheRef = getProjectCacheRefFromImageTag(imageTag);

  const args = [
    "buildx",
    "build",
    "--builder",
    builder,
    "-f",
    "Containerfile",
    options.noCache ? "--no-cache" : undefined,
    ...(useRegistryCache
      ? [
          "--cache-to",
          `type=registry,mode=max,image-manifest=true,oci-mediatypes=true,ref=${projectCacheRef}`,
          "--cache-from",
          `type=registry,ref=${projectCacheRef}`,
        ]
      : []),
    "--platform",
    options.imagePlatform,
    options.network ? `--network=${options.network}` : undefined,
    addHost ? `--add-host=${addHost}` : undefined,
    "--provenance",
    "false",
    "--metadata-file",
    "metadata.json",
    "--build-arg",
    `SOURCE_DATE_EPOCH=0`,
    "--build-arg",
    `TRIGGER_PROJECT_ID=${options.projectId}`,
    "--build-arg",
    `TRIGGER_DEPLOYMENT_ID=${options.deploymentId}`,
    "--build-arg",
    `TRIGGER_CONTENT_HASH=${options.contentHash}`,
    "--build-arg",
    `TRIGGER_PROJECT_REF=${options.projectRef}`,
    "--build-arg",
    `TRIGGER_API_URL=${apiUrl}`,
    "--build-arg",
    `TRIGGER_PREVIEW_BRANCH=${options.branchName ?? ""}`,
    "--build-arg",
    `TRIGGER_SECRET_KEY=${options.apiKey}`,
    ...(buildArgs || []),
    ...(options.extraCACerts ? ["--build-arg", `NODE_EXTRA_CA_CERTS=${options.extraCACerts}`] : []),
    "--output",
    `type=image,name=${imageTag},rewrite-timestamp=true${push ? ",push=true" : ""}${
      load ? ",load=true" : ""
    }`,
    "--progress",
    "plain",
    ".", // The build context
  ].filter(Boolean) as string[];

  logger.debug(`docker ${args.join(" ")}`, { cwd: options.cwd });

  const buildProcess = x("docker", args, {
    nodeOptions: {
      cwd: options.cwd,
    },
  });

  for await (const line of buildProcess) {
    // line will be from stderr/stdout in the order you'd see it in a term
    errors.push(line);
    logger.debug(line);
    options.onLog?.(line);
  }

  if (buildProcess.exitCode !== 0) {
    if (cloudRegistryHost) {
      logger.debug(`Logging out from docker registry: ${cloudRegistryHost}`);
      await x("docker", ["logout", cloudRegistryHost]);
    }

    return {
      ok: false as const,
      error: "Error building image",
      logs: extractLogs(errors),
    };
  }

  const metadataPath = join(options.cwd, "metadata.json");
  const rawMetadata = await safeReadJSONFile(metadataPath);

  const meta = BuildKitMetadata.safeParse(rawMetadata);

  let digest: string | undefined;
  if (!meta.success) {
    logger.error("Failed to parse metadata.json", {
      errors: meta.error.message,
      path: metadataPath,
    });
  } else {
    logger.debug("Parsed metadata.json", { metadata: meta.data, path: metadataPath });

    // Always use the manifest (list) digest
    digest = meta.data["containerimage.digest"];
  }

  // Get the image size
  const sizeProcess = x("docker", ["image", "inspect", options.imageTag, "--format={{.Size}}"], {
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

  if (cloudRegistryHost) {
    logger.debug(`Logging out from docker registry: ${cloudRegistryHost}`);
    await x("docker", ["logout", cloudRegistryHost]);
  }

  return {
    ok: true as const,
    imageSizeBytes,
    digest,
    logs: extractLogs(errors),
  };
}

function extractLogs(outputs: string[]) {
  // Remove empty lines
  const cleanedOutputs = outputs.map((line) => line.trim()).filter((line) => line !== "");

  return cleanedOutputs.map((line) => line.trim()).join("\n");
}

export type GenerateContainerfileOptions = {
  runtime: BuildRuntime;
  build: BuildManifest["build"];
  image: BuildManifest["image"];
  indexScript: string;
  entrypoint: string;
};

const BASE_IMAGE: Record<BuildRuntime, string> = {
  bun: "imbios/bun-node:1.3.3-20-slim@sha256:59d84856a7e31eec83afedadb542f7306f672343b8b265c70d733404a6e8834b",
  node: "node:21.7.3-bookworm-slim@sha256:dfc05dee209a1d7adf2ef189bd97396daad4e97c6eaa85778d6f75205ba1b0fb",
  "node-22":
    "node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34",
};

const DEFAULT_PACKAGES = ["busybox", "ca-certificates", "dumb-init", "git", "openssl"];

export async function generateContainerfile(options: GenerateContainerfileOptions) {
  switch (options.runtime) {
    case "node":
    case "node-22": {
      return await generateNodeContainerfile(options);
    }
    case "bun": {
      return await generateBunContainerfile(options);
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

async function generateBunContainerfile(options: GenerateContainerfileOptions) {
  const { baseImage, buildArgs, buildEnvVars, postInstallCommands, baseInstructions, packages } =
    parseGenerateOptions(options);

  return `# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
FROM ${baseImage} AS base

${baseInstructions}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
  apt-get --fix-broken install -y && \
  apt-get install -y --no-install-recommends ${packages} && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

FROM base AS build

RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

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

FROM build AS indexer

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
ARG TRIGGER_PREVIEW_BRANCH

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_SECRET_KEY=\${TRIGGER_SECRET_KEY} \
    TRIGGER_API_URL=\${TRIGGER_API_URL} \
    TRIGGER_PREVIEW_BRANCH=\${TRIGGER_PREVIEW_BRANCH} \
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \
    NODE_ENV=production

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ENV BUILDPLATFORM=$BUILDPLATFORM TARGETPLATFORM=$TARGETPLATFORM

# Run the indexer
RUN bun run ${options.indexScript}

# Development or production stage builds upon the base stage
FROM base AS final

USER bun
WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    UV_USE_IO_URING=0 \
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
  const { baseImage, buildArgs, buildEnvVars, postInstallCommands, baseInstructions, packages } =
    parseGenerateOptions(options);

  return `# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
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
ARG TRIGGER_PREVIEW_BRANCH

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_DEPLOYMENT_ID=\${TRIGGER_DEPLOYMENT_ID} \
    TRIGGER_DEPLOYMENT_VERSION=\${TRIGGER_DEPLOYMENT_VERSION} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_SECRET_KEY=\${TRIGGER_SECRET_KEY} \
    TRIGGER_API_URL=\${TRIGGER_API_URL} \
    TRIGGER_PREVIEW_BRANCH=\${TRIGGER_PREVIEW_BRANCH} \
    TRIGGER_LOG_LEVEL=debug \
    NODE_EXTRA_CA_CERTS=\${NODE_EXTRA_CA_CERTS} \
    NODE_ENV=production \
    NODE_OPTIONS="--max_old_space_size=8192"

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ENV BUILDPLATFORM=$BUILDPLATFORM TARGETPLATFORM=$TARGETPLATFORM

# Run the indexer
RUN node ${options.indexScript}

# Development or production stage builds upon the base stage
FROM base AS final

USER node
WORKDIR /app

ARG TRIGGER_PROJECT_ID
ARG TRIGGER_CONTENT_HASH
ARG TRIGGER_PROJECT_REF
ARG NODE_EXTRA_CA_CERTS

ENV TRIGGER_PROJECT_ID=\${TRIGGER_PROJECT_ID} \
    TRIGGER_CONTENT_HASH=\${TRIGGER_CONTENT_HASH} \
    TRIGGER_PROJECT_REF=\${TRIGGER_PROJECT_REF} \
    UV_USE_IO_URING=0 \
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

// If apiUrl is something like http://localhost:3030, we need to convert it to http://host.docker.internal:3030
// this way the indexing will work because the docker image can reach the local server
function normalizeApiUrlForBuild(apiUrl: string): string {
  return apiUrl.replace("localhost", "host.docker.internal");
}

function getHostIP() {
  const interfaces = networkInterfaces();

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) {
      continue;
    }

    for (const net of iface) {
      // Skip internal/loopback and non-IPv4 addresses
      if (!net.internal && net.family === "IPv4") {
        return net.address;
      }
    }
  }

  return "127.0.0.1";
}

function getAddHost(apiUrl: string) {
  if (apiUrl.includes("host.docker.internal")) {
    return `host.docker.internal:${getHostIP()}`;
  }

  return;
}

function extractRegistryHostFromImageTag(imageTag: string): string | undefined {
  const host = imageTag.split("/")[0];

  if (!host || !host.includes(".")) {
    return undefined;
  }

  return host;
}

function getProjectCacheRefFromImageTag(imageTag: string): string {
  const lastColonIndex = imageTag.lastIndexOf(":");
  return `${imageTag.substring(0, lastColonIndex)}:cache`;
}

async function getDockerUsernameAndPassword(
  apiClient: CliApiClient,
  deploymentId: string
): Promise<{ username: string; password: string }> {
  if (process.env.TRIGGER_DOCKER_USERNAME && process.env.TRIGGER_DOCKER_PASSWORD) {
    return {
      username: process.env.TRIGGER_DOCKER_USERNAME,
      password: process.env.TRIGGER_DOCKER_PASSWORD,
    };
  }

  const result = await apiClient.generateRegistryCredentials(deploymentId);

  if (!result.success) {
    logger.debug("Failed to generate registry credentials", {
      error: result.error,
      deploymentId,
    });
    throw new Error("Failed to generate registry credentials");
  }

  return {
    username: result.data.username,
    password: result.data.password,
  };
}

function isQemuRegistered() {
  try {
    // Check a single QEMU handler
    const binfmt = readFileSync("/proc/sys/fs/binfmt_misc/qemu-aarch64", "utf8");
    return binfmt.includes("enabled");
  } catch (e) {
    return false;
  }
}

function isMultiPlatform(imagePlatform: string) {
  return imagePlatform.split(",").length > 1;
}

async function ensureQemuRegistered(imagePlatform: string) {
  if (isLinux && isMultiPlatform(imagePlatform) && !isQemuRegistered()) {
    logger.debug("Registering QEMU for multi-platform build...");

    const ensureQemuProcess = x("docker", [
      "run",
      "--rm",
      "--privileged",
      "multiarch/qemu-user-static",
      "--reset",
      "-p",
      "yes",
    ]);

    const logs: string[] = [];
    for await (const line of ensureQemuProcess) {
      logger.debug(line);
      logs.push(line);
    }

    if (ensureQemuProcess.exitCode !== 0) {
      logger.error("Failed to register QEMU for multi-platform build", {
        exitCode: ensureQemuProcess.exitCode,
        logs: logs.join("\n"),
      });
    }
  }
}

const BuildKitMetadata = z.object({
  "buildx.build.ref": z.string().optional(),
  "containerimage.descriptor": z
    .object({
      mediaType: z.string(),
      digest: z.string(),
      size: z.number(),
    })
    .optional(),
  "containerimage.digest": z.string().optional(),
  "containerimage.config.digest": z.string().optional(),
  "image.name": z.string().optional(),
});

// Don't push if the image tag is a local address, unless the user explicitly wants to push
function shouldPush(imageTag: string, push?: boolean) {
  switch (push) {
    case true: {
      return true;
    }
    case false: {
      return false;
    }
    case undefined: {
      return imageTag.startsWith("localhost") ||
        imageTag.startsWith("127.0.0.1") ||
        imageTag.startsWith("0.0.0.0")
        ? false
        : true;
    }
    default: {
      assertExhaustive(push);
    }
  }
}

// Don't load if we're pushing, unless the user explicitly wants to load
function shouldLoad(load?: boolean, push?: boolean) {
  switch (load) {
    case true: {
      return true;
    }
    case false: {
      return false;
    }
    case undefined: {
      return push ? false : true;
    }
    default: {
      assertExhaustive(load);
    }
  }
}
