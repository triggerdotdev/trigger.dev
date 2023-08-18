import inquirer from "inquirer";
import pathModule from "node:path";
import ora from "ora";
import { z } from "zod";
import { COMMAND_NAME } from "../consts";
import { getLatestPackageVersion } from "../utils/addDependencies";
import { createFile, pathExists, readJSONFile, writeJSONFile } from "../utils/fileSystem";
import { generateIntegrationFiles } from "../utils/generateIntegrationFiles";
import { getPackageName } from "../utils/getPackagName";
import { installDependencies } from "../utils/installDependencies";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";

const CLIOptionsSchema = z.object({
  packageName: z.string().optional(),
  sdkPackage: z.string().optional(),
  extraInfo: z.string().optional(),
  skipGeneratingCode: z.coerce.boolean().optional(),
  authMethod: z.enum(["api-key", "oauth", "both-methods"]).optional(),
});

type CLIOptions = z.infer<typeof CLIOptionsSchema>;
type ResolvedCLIOptions = Required<CLIOptions>;

export async function createIntegrationCommand(path: string, cliOptions: any) {
  const result = CLIOptionsSchema.safeParse(cliOptions);

  if (!result.success) {
    logger.error(result.error.message);

    process.exit(1);
  }

  const options = result.data;

  const resolvedPath = resolvePath(path);

  // make sure the resolvedPath doesn't exist
  // if it does, print a warning and exit
  const resolvedPathExists = await pathExists(resolvedPath);

  if (resolvedPathExists) {
    logger.error(
      `The path ${resolvedPath} already exists. Please try again with a different path.`
    );

    process.exit(1);
  }

  const resolvedOptions = await resolveOptionsWithPrompts(options, resolvedPath);

  const latestVersion = await getLatestPackageVersion(resolvedOptions.sdkPackage, "latest");

  if (!latestVersion) {
    logger.error(
      `Could not find the latest version of ${resolvedOptions.sdkPackage}. Please try again later.`
    );

    process.exit(1);
  }

  const triggerMonorepoPath = await detectTriggerMonorepoPath(resolvedPath);

  const sdkVersion = await getInternalOrExternalPackageVersion({
    path: "packages/trigger-sdk",
    packageName: "@trigger.dev/sdk",
    tag: "latest",
    monorepoPath: triggerMonorepoPath,
  });

  if (!sdkVersion) {
    logger.error(`Could not find the latest version of @trigger.dev/sdk. Please try again later.`);

    process.exit(1);
  }

  const integrationKitVersion = await getInternalOrExternalPackageVersion({
    path: "packages/integration-kit",
    packageName: "@trigger.dev/integration-kit",
    tag: "latest",
    monorepoPath: triggerMonorepoPath,
  });

  if (!integrationKitVersion) {
    logger.error(
      `Could not find the latest version of @trigger.dev/integration-kit. Please try again later.`
    );

    process.exit(1);
  }

  // Create the package.json
  const packageJson = {
    name: resolvedOptions.packageName,
    version: "0.0.1",
    description: `Trigger.dev integration for ${resolvedOptions.sdkPackage}`,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    publishConfig: {
      access: "public",
    },
    files: ["dist/index.js", "dist/index.d.ts", "dist/index.js.map"],
    devDependencies: {
      "@types/node": "16.x",
      rimraf: "^3.0.2",
      tsup: "7.1.x",
      typescript: "4.9.4",
    },
    scripts: {
      clean: "rimraf dist",
      build: "npm run clean && npm run build:tsup",
      "build:tsup": "tsup",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      [latestVersion.name]: `^${latestVersion.version}`,
      [sdkVersion.name]: sdkVersion.version,
      [integrationKitVersion.name]: integrationKitVersion.version,
    },
    engines: {
      node: ">=16.8.0",
    },
  };

  await createFileInPath(resolvedPath, "package.json", JSON.stringify(packageJson, null, 2));

  // Create the tsconfig.json
  const tsconfigJson = {
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      inlineSources: false,
      isolatedModules: true,
      moduleResolution: "node16",
      noUnusedLocals: false,
      noUnusedParameters: false,
      preserveWatchOutput: true,
      skipLibCheck: true,
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      sourceMap: true,
      resolveJsonModule: true,
      lib: ["es2019"],
      module: "commonjs",
      target: "es2021",
    },
    include: ["./src/**/*.ts", "tsup.config.ts"],
    exclude: ["node_modules"],
  };

  await createFileInPath(resolvedPath, "tsconfig.json", JSON.stringify(tsconfigJson, null, 2));

  const readme = `
# ${resolvedOptions.packageName}
  `;

  await createFileInPath(resolvedPath, "README.md", readme);

  // Create the tsup.config.ts
  const tsupConfig = `
import { defineConfig } from "tsup";

export default defineConfig([
  {
    name: "main",
    entry: ["./src/index.ts"],
    outDir: "./dist",
    platform: "node",
    format: ["cjs"],
    legacyOutput: true,
    sourcemap: true,
    clean: true,
    bundle: true,
    splitting: false,
    dts: true,
    treeshake: {
      preset: "smallest",
    },
    esbuildPlugins: [],
    external: ["http", "https", "util", "events", "tty", "os", "timers"],
  },
]);

`;

  await createFileInPath(resolvedPath, "tsup.config.ts", tsupConfig);

  if (resolvedOptions.skipGeneratingCode) {
    await createFileInPath(resolvedPath, "src/index.ts", "export {}");
  } else {
    await attemptToGenerateIntegrationFiles(pathModule.join(resolvedPath, "src"), resolvedOptions);
  }

  // If inside the monorepo:
  if (triggerMonorepoPath) {
    //adds the integration run script to the job-catalog/package.json
    //adds the path to the integration to the job-catalog/tsconfig.json
    await updateJobCatalogWithNewIntegration(triggerMonorepoPath, resolvedPath, resolvedOptions);
  }

  // Install the dependencies
  await installDependencies(resolvedPath);

  logger.success(`✅ Successfully initialized ${resolvedOptions.packageName} at ${resolvedPath}`);
  logger.info("Next steps:");
  logger.info(`   1. If you generated code, double check it for errors.`);
  logger.info(
    `   2. Read the "Creating an Integration" guide at https://trigger.dev/docs/integrations/create`
  );

  if (triggerMonorepoPath) {
    logger.info(`   3. Write some test jobs in the examples/nextjs-example project`);
  }
}

async function attemptToGenerateIntegrationFiles(path: string, options: ResolvedCLIOptions) {
  const spinner = ora("Generating integration code (may take ~30s)").start();

  function generateExtraInfo(
    authMethod: "api-key" | "oauth" | "both-methods",
    extraInfo?: string
  ): string {
    let authExtraInfo = "";

    switch (authMethod) {
      case "api-key": {
        authExtraInfo =
          "Note that the only auth method that this integration supports is API keys so can only useLocalAuth to true and don't use the clientFactory option";
        break;
      }
      case "oauth": {
        authExtraInfo =
          "Note that the only auth method that this integration supports is OAuth so can only useLocalAuth to false and make sure to use the clientFactory option";
        break;
      }
      case "both-methods": {
        authExtraInfo =
          "Note that this integration supports both API keys and OAuth so the options passed to the constructor must support both.";
        break;
      }
    }

    return `${authExtraInfo}\n\n${extraInfo ?? ""}`;
  }

  const extraInfo = generateExtraInfo(options.authMethod, options.extraInfo);

  const files = await generateIntegrationFiles({
    packageName: options.packageName,
    sdkPackage: options.sdkPackage,
    extraInfo,
  });

  if (files) {
    await Promise.all(
      Object.entries(files).map(([file, contents]) => createFileInPath(path, file, contents))
    );

    spinner.succeed(`Generated integration code in ${path}`);
  } else {
    spinner.fail("Failed to generate integration code");
  }
}

async function createFileInPath(path: string, fileName: string, contents: string) {
  await createFile(pathModule.join(path, fileName), contents);
}

const resolveOptionsWithPrompts = async (
  options: CLIOptions,
  path: string
): Promise<ResolvedCLIOptions> => {
  const resolvedOptions: CLIOptions = { ...options };

  try {
    if (!options.packageName) {
      resolvedOptions.packageName = await promptPackageName(path);
    }

    if (!options.sdkPackage) {
      resolvedOptions.sdkPackage = await promptSdkPackage();
    }

    if (!process.env.OPENAI_API_KEY) {
      resolvedOptions.skipGeneratingCode = true;
    }

    if (!resolvedOptions.skipGeneratingCode) {
      resolvedOptions.authMethod = await promptAuthMethod();
      resolvedOptions.extraInfo = await promptExtraInfo();
    }
  } catch (err) {
    // If the user is not calling the command from an interactive terminal, inquirer will throw an error with isTTYError = true
    // If this happens, we catch the error, tell the user what has happened, and then continue to run the program with a default trigger project
    // Otherwise we have to do some fancy namespace extension logic on the Error type which feels overkill for one line
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof Error && (err as any).isTTYError) {
      logger.warn(
        `'${COMMAND_NAME} create-integration' needs an interactive terminal to provide options`
      );

      const { shouldContinue } = await inquirer.prompt<{
        shouldContinue: boolean;
      }>({
        name: "shouldContinue",
        type: "confirm",
        message: `Continue initializing your trigger.dev project?`,
        default: true,
      });

      if (!shouldContinue) {
        logger.info("Exiting...");
        process.exit(0);
      }
    } else {
      throw err;
    }
  }

  return resolvedOptions as ResolvedCLIOptions;
};

export const promptPackageName = async (path: string): Promise<string> => {
  const basename = pathModule.basename(path);

  const { packageName } = await inquirer.prompt<{ packageName: string }>({
    type: "input",
    name: "packageName",
    default: `@trigger.dev/${basename}`,
    message: "What is the name of your integration package?",
    validate: (input) => {
      if (!input) {
        return "Please enter a package name";
      }

      return true;
    },
  });

  return packageName;
};

export const promptSdkPackage = async (): Promise<string> => {
  const { sdkPackage } = await inquirer.prompt<{ sdkPackage: string }>({
    type: "input",
    name: "sdkPackage",
    message: "What is the name of the npm package of the integration?",
    validate: (input) => {
      if (!input) {
        return "Please enter an SDK package name";
      }

      return true;
    },
  });

  return sdkPackage;
};

export const promptExtraInfo = async (): Promise<string | undefined> => {
  const { extraInfo } = await inquirer.prompt<{ extraInfo?: string }>({
    type: "input",
    name: "extraInfo",
    message:
      "Please describe in english anything else about using the SDK that might be useful (optional)",
  });

  return extraInfo;
};

// Choose between api-key, oauth, or both
export const promptAuthMethod = async (): Promise<"api-key" | "oauth" | "both-methods"> => {
  const { authMethod } = await inquirer.prompt<{
    authMethod: "api-key" | "oauth" | "both-methods";
  }>({
    type: "list",
    name: "authMethod",
    message: "What authentication method does this API use?",
    choices: [
      {
        name: "API Key",
        value: "api-key",
      },
      {
        name: "OAuth",
        value: "oauth",
      },
      {
        name: "Both API Key and OAuth",
        value: "both-methods",
      },
    ],
  });

  return authMethod;
};

export const promptSkipGeneratingCode = async (): Promise<boolean> => {
  const { skipGeneratingCode } = await inquirer.prompt<{
    skipGeneratingCode: boolean;
  }>({
    type: "checkbox",
    name: "skipGeneratingCode",
    default: false,
    message: "Would you like to skip generating the initial code?",
  });

  return skipGeneratingCode;
};

// Find where the github repo is located and check if it's the trigger.dev monorepo
async function detectTriggerMonorepoPath(path: string): Promise<string | undefined> {
  const gitPath = await findGitPath(path);

  if (!gitPath) {
    return;
  }

  // Read the package.json file at
  const rootPackageJsonPath = pathModule.join(gitPath, "package.json");
  const rootPackageJsonExists = await pathExists(rootPackageJsonPath);

  if (!rootPackageJsonExists) {
    return;
  }

  const rootPackageJson = await readJSONFile(rootPackageJsonPath);

  if (rootPackageJson.name === "triggerdotdev") {
    return gitPath;
  }

  return;
}

async function getInternalOrExternalPackageVersion({
  packageName,
  tag,
  path,
  monorepoPath,
}: {
  packageName: string;
  tag: string;
  path: string;
  monorepoPath?: string;
}): Promise<{ name: string; version: string } | undefined> {
  if (!monorepoPath) {
    return await getLatestPackageVersion(packageName, tag);
  }

  // If there is a monorepo path then we will read the version from the package.json at that path
  const packageJsonPath = pathModule.join(monorepoPath, path, "package.json");
  const packageJsonExists = await pathExists(packageJsonPath);

  if (!packageJsonExists) {
    return await getLatestPackageVersion(packageName, tag);
  }

  const packageJson = await readJSONFile(packageJsonPath);

  return {
    name: packageJson.name,
    version: `workspace:^${packageJson.version}`,
  };
}

// Recursively search for a .git folder
async function findGitPath(path: string): Promise<string | undefined> {
  const gitPath = pathModule.join(path, ".git");

  const gitPathExists = await pathExists(gitPath);

  if (gitPathExists) {
    return path;
  }

  const parentPath = pathModule.dirname(path);

  if (parentPath === path) {
    return undefined;
  }

  return findGitPath(parentPath);
}

async function updateJobCatalogWithNewIntegration(
  monorepoPath: string,
  integrationPath: string,
  resolvedOptions: ResolvedCLIOptions
) {
  const packageName = getPackageName(resolvedOptions.packageName);
  const jobCatalogPath = pathModule.join(monorepoPath, "examples", "job-catalog");
  const jobCatalogSrcFolder = pathModule.join(jobCatalogPath, "src");

  const integrationFile = `export {}`;

  await createFileInPath(jobCatalogSrcFolder, `${packageName}.ts`, integrationFile);

  const packageJsonPath = pathModule.join(jobCatalogPath, "package.json");

  const packageJson = await readJSONFile(packageJsonPath);
  const newPackageJson = {
    ...packageJson,
    scripts: {
      ...packageJson.scripts,
      [packageName]: `nodemon --watch src/${packageName}.ts -r tsconfig-paths/register -r dotenv/config src/${packageName}.ts`,
    },
    dependencies: {
      ...packageJson.dependencies,
      [resolvedOptions.packageName]: `workspace:*`,
    },
  };

  // Move "dev:trigger script" to the last position in the scripts object
  if (newPackageJson.scripts.hasOwnProperty("dev:trigger")) {
    const devTriggerScript = newPackageJson.scripts["dev:trigger"];
    delete newPackageJson.scripts["dev:trigger"];
    newPackageJson.scripts["dev:trigger"] = devTriggerScript;
  }

  await writeJSONFile(packageJsonPath, newPackageJson);

  const tsConfigPath = pathModule.join(jobCatalogPath, "tsconfig.json");
  const tsConfig = await readJSONFile(tsConfigPath);

  const newTsConfig = {
    ...tsConfig,
    compilerOptions: {
      ...tsConfig.compilerOptions,
      paths: {
        ...tsConfig.compilerOptions.paths,
        [resolvedOptions.packageName]: [
          `../../integrations/${pathModule.basename(integrationPath)}/src/index`,
        ],
        [`${resolvedOptions.packageName}/*`]: [
          `../../integrations/${pathModule.basename(integrationPath)}/src/*`,
        ],
      },
    },
  };
  await writeJSONFile(tsConfigPath, newTsConfig);
}
