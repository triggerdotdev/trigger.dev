import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3/schemas";
import { BundleResult, bundleWorker, createBuildManifestFromBundle } from "./bundle.js";
import {
  createBuildContext,
  notifyExtensionOnBuildComplete,
  notifyExtensionOnBuildStart,
  resolvePluginsForContext,
} from "./extensions.js";
import { createExternalsBuildExtension } from "./externals.js";
import { join, relative, sep } from "node:path";
import { generateContainerfile } from "../deploy/buildImage.js";
import { writeFile } from "node:fs/promises";
import { buildManifestToJSON } from "../utilities/buildManifest.js";
import { readPackageJSON, writePackageJSON } from "pkg-types";
import { writeJSONFile } from "../utilities/fileSystem.js";
import { isWindows } from "std-env";
import { pathToFileURL } from "node:url";
import { logger } from "../utilities/logger.js";
import { SdkVersionExtractor } from "./plugins.js";

export type BuildWorkerEventListener = {
  onBundleStart?: () => void;
  onBundleComplete?: (result: BundleResult) => void;
};

export type BuildWorkerOptions = {
  destination: string;
  target: BuildTarget;
  environment: string;
  resolvedConfig: ResolvedConfig;
  listener?: BuildWorkerEventListener;
  envVars?: Record<string, string>;
  rewritePaths?: boolean;
  forcedExternals?: string[];
};

export async function buildWorker(options: BuildWorkerOptions) {
  logger.debug("Starting buildWorker", {
    options,
  });

  const resolvedConfig = options.resolvedConfig;

  const externalsExtension = createExternalsBuildExtension(
    options.target,
    resolvedConfig,
    options.forcedExternals
  );
  const buildContext = createBuildContext(options.target, resolvedConfig);
  buildContext.prependExtension(externalsExtension);
  await notifyExtensionOnBuildStart(buildContext);
  const pluginsFromExtensions = resolvePluginsForContext(buildContext);

  const sdkVersionExtractor = new SdkVersionExtractor();

  options.listener?.onBundleStart?.();

  const bundleResult = await bundleWorker({
    target: options.target,
    cwd: resolvedConfig.workingDir,
    destination: options.destination,
    watch: false,
    resolvedConfig,
    plugins: [sdkVersionExtractor.plugin, ...pluginsFromExtensions],
    jsxFactory: resolvedConfig.build.jsx.factory,
    jsxFragment: resolvedConfig.build.jsx.fragment,
    jsxAutomatic: resolvedConfig.build.jsx.automatic,
  });

  options.listener?.onBundleComplete?.(bundleResult);

  let buildManifest = await createBuildManifestFromBundle({
    bundle: bundleResult,
    destination: options.destination,
    resolvedConfig,
    environment: options.environment,
    target: options.target,
    envVars: options.envVars,
  });

  buildManifest = await notifyExtensionOnBuildComplete(buildContext, buildManifest);

  if (options.target !== "dev") {
    buildManifest = options.rewritePaths
      ? rewriteBuildManifestPaths(buildManifest, options.destination)
      : buildManifest;

    await writeDeployFiles(buildManifest, resolvedConfig, options.destination);
  }

  return buildManifest;
}

export function rewriteBuildManifestPaths(
  buildManifest: BuildManifest,
  destinationDir: string
): BuildManifest {
  return {
    ...buildManifest,
    files: buildManifest.files.map((file) => ({
      ...file,
      entry: cleanEntryPath(file.entry),
      out: rewriteOutputPath(destinationDir, file.out),
    })),
    outputPath: rewriteOutputPath(destinationDir, buildManifest.outputPath),
    configPath: rewriteOutputPath(destinationDir, buildManifest.configPath),
    runControllerEntryPoint: buildManifest.runControllerEntryPoint
      ? rewriteOutputPath(destinationDir, buildManifest.runControllerEntryPoint)
      : undefined,
    runWorkerEntryPoint: rewriteOutputPath(destinationDir, buildManifest.runWorkerEntryPoint),
    indexControllerEntryPoint: buildManifest.indexControllerEntryPoint
      ? rewriteOutputPath(destinationDir, buildManifest.indexControllerEntryPoint)
      : undefined,
    indexWorkerEntryPoint: rewriteOutputPath(destinationDir, buildManifest.indexWorkerEntryPoint),
    loaderEntryPoint: buildManifest.loaderEntryPoint
      ? rewriteOutputPath(destinationDir, buildManifest.loaderEntryPoint)
      : undefined,
    initEntryPoint: buildManifest.initEntryPoint
      ? rewriteOutputPath(destinationDir, buildManifest.initEntryPoint)
      : undefined,
  };
}
// Remove any query parameters from the entry path
// For example, src/trigger/ai.ts?sentryProxyModule=true -> src/trigger/ai.ts
function cleanEntryPath(entry: string): string {
  return entry.split("?")[0]!;
}

function rewriteOutputPath(destinationDir: string, filePath: string) {
  if (isWindows) {
    return `/app/${relative(
      pathToFileURL(destinationDir).pathname,
      pathToFileURL(filePath).pathname
    )
      .split(sep)
      .join("/")}`;
  } else {
    return `/app/${relative(destinationDir, filePath)}`;
  }
}

async function writeDeployFiles(
  buildManifest: BuildManifest,
  resolvedConfig: ResolvedConfig,
  outputPath: string
) {
  // Step 1. Read the package.json file
  const packageJson = await readProjectPackageJson(resolvedConfig.packageJsonPath);

  if (!packageJson) {
    throw new Error("Could not read the package.json file");
  }

  const dependencies =
    buildManifest.externals?.reduce(
      (acc, external) => {
        acc[external.name] = external.version;

        return acc;
      },
      {} as Record<string, string>
    ) ?? {};

  // Step 3: Write the resolved dependencies to the package.json file
  await writePackageJSON(join(outputPath, "package.json"), {
    ...packageJson,
    name: packageJson.name ?? "trigger-project",
    dependencies: {
      ...dependencies,
    },
    trustedDependencies: Object.keys(dependencies),
    devDependencies: {},
    peerDependencies: {},
    scripts: {},
  });

  await writeJSONFile(join(outputPath, "build.json"), buildManifestToJSON(buildManifest));
  await writeContainerfile(outputPath, buildManifest);
}

async function readProjectPackageJson(packageJsonPath: string) {
  const packageJson = await readPackageJSON(packageJsonPath);

  return packageJson;
}

async function writeContainerfile(outputPath: string, buildManifest: BuildManifest) {
  if (!buildManifest.runControllerEntryPoint || !buildManifest.indexControllerEntryPoint) {
    throw new Error("Something went wrong with the build. Aborting deployment. [code 7789]");
  }

  const containerfile = await generateContainerfile({
    runtime: buildManifest.runtime,
    entrypoint: buildManifest.runControllerEntryPoint,
    build: buildManifest.build,
    image: buildManifest.image,
    indexScript: buildManifest.indexControllerEntryPoint,
  });

  const containerfilePath = join(outputPath, "Containerfile");

  logger.debug("Writing Containerfile", { containerfilePath });
  logger.debug(containerfile);

  await writeFile(containerfilePath, containerfile);
}
