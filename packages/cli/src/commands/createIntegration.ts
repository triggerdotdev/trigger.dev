import { z } from "zod";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { COMMAND_NAME } from "../consts.js";
import inquirer from "inquirer";
// import { OpenAIApi } from "openai";

const CLIOptionsSchema = z.object({
  packageName: z.string().optional(),
  sdkPackage: z.string().optional(),
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

  const resolvedOptions = await resolveOptionsWithPrompts(
    options,
    resolvedPath
  );

  console.log(resolvedOptions);
}

const resolveOptionsWithPrompts = async (
  options: CLIOptions,
  _path: string
): Promise<ResolvedCLIOptions> => {
  const resolvedOptions: CLIOptions = { ...options };

  try {
    if (!options.packageName) {
      resolvedOptions.packageName = await promptPackageName();
    }

    if (!options.sdkPackage) {
      resolvedOptions.sdkPackage = await promptSdkPackage();
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

export const promptPackageName = async (): Promise<string> => {
  const { packageName } = await inquirer.prompt<{ packageName: string }>({
    type: "input",
    name: "packageName",
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
    message: "What is the name of the SDK package you would like to use?",
    validate: (input) => {
      if (!input) {
        return "Please enter an SDK package name";
      }

      return true;
    },
  });

  return sdkPackage;
};
