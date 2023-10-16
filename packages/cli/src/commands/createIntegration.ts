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
import { relativePath, resolvePath } from "../utils/parseNameAndPath";
import { createIntegrationFileFromTemplate } from "../utils/createIntegrationFileFromTemplate";

const CLIOptionsSchema = z.object({
  packageName: z.string().optional(),
  sdkPackage: z.string().optional(),
  extraInfo: z.string().optional(),
  skipGeneratingCode: z.coerce.boolean().optional(),
  authMethod: z.enum(["api-key", "oauth", "both-methods"]).optional(),
  openaiKey: z.string().optional(),
  openaiOrg: z.string().optional(),
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

  const integrationVersion = await getInternalOrExternalPackageVersion({
    path: "integrations/github",
    packageName: "@trigger.dev/github",
    tag: "latest",
    monorepoPath: triggerMonorepoPath,
    prependWorkspace: false,
  });

  if (!integrationVersion) {
    logger.error(
      `Could not find the latest version of @trigger.dev/github. Please try again later.`
    );

    process.exit(1);
  }

  const baseVariables = {
    packageName: resolvedOptions.packageName,
    sdkPackage: resolvedOptions.sdkPackage,
    integrationVersion: integrationVersion,
    latestVersion: latestVersion,
    sdkVersion: sdkVersion,
    integrationKitVersion: integrationKitVersion,
    triggerMonorepoPath,
  };

  const getOutputPath = (relativePath: string) => pathModule.join(resolvedPath, relativePath);

  const miscIntegrationFiles = [
    {
      relativeTemplatePath: "package.json.j2",
      outputPath: getOutputPath("package.json"),
    },
    {
      // use `tsc --showConfig` to update external tsconfig
      relativeTemplatePath: `tsconfig-${triggerMonorepoPath ? "internal" : "external"}.json.j2`,
      outputPath: getOutputPath("tsconfig.json"),
    },
    {
      relativeTemplatePath: `tsup.config-${triggerMonorepoPath ? "internal" : "external"}.js.j2`,
      outputPath: getOutputPath("tsup.config.ts"),
    },
    {
      relativeTemplatePath: "README.md.j2",
      outputPath: getOutputPath("README.md"),
    },
  ];

  await createIntegrationFiles(miscIntegrationFiles, baseVariables);

  // create src/*
  if (resolvedOptions.skipGeneratingCode) {
    const getSrcOutputPath = (relativePath: string) =>
      getOutputPath(pathModule.join("src", relativePath));

    const srcIntegrationFiles = [
      {
        relativeTemplatePath: pathModule.join("payload-examples", "index.js.j2"),
        outputPath: getSrcOutputPath(pathModule.join("payload-examples", "index.ts")),
      },
      {
        relativeTemplatePath: "events.js.j2",
        outputPath: getSrcOutputPath("events.ts"),
      },
      {
        relativeTemplatePath: "index.js.j2",
        outputPath: getSrcOutputPath("index.ts"),
      },
      {
        relativeTemplatePath: "models.js.j2",
        outputPath: getSrcOutputPath("models.ts"),
      },
      {
        relativeTemplatePath: "schemas.js.j2",
        outputPath: getSrcOutputPath("schemas.ts"),
      },
      {
        relativeTemplatePath: "types.js.j2",
        outputPath: getSrcOutputPath("types.ts"),
      },
      {
        relativeTemplatePath: "utils.js.j2",
        outputPath: getSrcOutputPath("utils.ts"),
      },
      {
        relativeTemplatePath: "webhooks.js.j2",
        outputPath: getSrcOutputPath("webhooks.ts"),
      },
    ];

    const validIdentifier = pathModule
      .basename(path)
      .replace(/[^a-zA-Z0-9]+/g, "")
      .replace(/^[0-9]+/g, "");

    await createIntegrationFiles(srcIntegrationFiles, {
      ...baseVariables,
      apiKeyPropertyName: "apiKey", // TODO: prompt for this
      authMethod: resolvedOptions.authMethod,
      identifier: validIdentifier.length ? validIdentifier : "packageName",
    });
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

  logger.success(`✔ Successfully initialized ${resolvedOptions.packageName} at ${resolvedPath}`);
  logger.info("Next steps:");
  logger.info(`   1. If you generated code, double check it for errors.`);
  logger.info(
    `   2. Read the "Creating an Integration" guide at https://trigger.dev/docs/integrations/create`
  );

  if (triggerMonorepoPath) {
    logger.info(`   3. Write some test jobs in the references/job-catalog`);
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

  const files = await generateIntegrationFiles(
    {
      packageName: options.packageName,
      sdkPackage: options.sdkPackage,
      extraInfo,
    },
    options.openaiKey ?? process.env.OPENAI_API_KEY,
    options.openaiOrg ?? process.env.OPENAI_ORGANIZATION
  );

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

    if (!process.env.OPENAI_API_KEY && !options.openaiKey) {
      resolvedOptions.skipGeneratingCode = true;
    }

    resolvedOptions.authMethod = await promptAuthMethod();

    if (!resolvedOptions.skipGeneratingCode) {
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
    message: "What is the name of the npm package for this API? (e.g. airtable)?",
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
  prependWorkspace = true,
}: {
  packageName: string;
  tag: string;
  path: string;
  monorepoPath?: string;
  prependWorkspace?: boolean;
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
    version: `${prependWorkspace ? "workspace:^" : ""}${packageJson.version}`,
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
  const jobCatalogPath = pathModule.join(monorepoPath, "references", "job-catalog");
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

const createIntegrationFiles = async (
  files: {
    relativeTemplatePath: string;
    outputPath: string;
  }[],
  variables?: Record<string, any>
) => {
  for (const file of files) {
    const result = await createIntegrationFileFromTemplate({ ...file, variables });
    handleCreateResult(file.outputPath, result);
  }
};

const handleCreateResult = (
  outputPath: string,
  result: Awaited<ReturnType<typeof createIntegrationFileFromTemplate>>
) => {
  if (!result.success) {
    throw new Error(`Failed to create ${pathModule.basename(outputPath)}: ${result.error}`);
  }
  logger.success(`✔ Created ${pathModule.basename(outputPath)} at ${relativePath(outputPath)}`);
};
