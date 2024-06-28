import chalk from "chalk";
import { relative } from "node:path";
import { chalkError, chalkPurple, chalkGrey, chalkGreen, chalkWarning, cliLink } from "./cliOutput";
import { logger } from "./logger";
import { ReadConfigResult } from "./configFiles";
import { z } from "zod";
import { groupTaskMetadataIssuesByTask } from "@trigger.dev/core/v3";
import { docs } from "./links";

export type ESMRequireError = {
  type: "esm-require-error";
  moduleName: string;
};

export type BuildError = ESMRequireError | string;

function errorIsErrorLike(error: unknown): error is Error {
  return (
    error instanceof Error || (typeof error === "object" && error !== null && "message" in error)
  );
}

export function parseBuildErrorStack(error: unknown): BuildError | undefined {
  if (typeof error === "string") {
    return error;
  }

  if (errorIsErrorLike(error)) {
    if (typeof error.stack === "string") {
      if (error.stack.includes("ERR_REQUIRE_ESM")) {
        const moduleName = getPackageNameFromEsmRequireError(error.stack);

        if (moduleName) {
          return {
            type: "esm-require-error",
            moduleName,
          };
        }
      }
    } else {
      return error.message;
    }
  }
}

function getPackageNameFromEsmRequireError(stack: string): string | undefined {
  const pathRegex = /require\(\) of ES Module (.*) from/;
  const pathMatch = pathRegex.exec(stack);

  if (!pathMatch) {
    return;
  }

  const filePath = pathMatch[1];

  if (!filePath) {
    return;
  }

  const lastPart = filePath.split("node_modules/").pop();

  if (!lastPart) {
    return;
  }

  // regular expression to match the package name
  const moduleRegex = /(@[^\/]+\/[^\/]+|[^\/]+)/;

  const match = moduleRegex.exec(lastPart);

  if (!match) {
    return;
  }

  return match[1];
}

export function logESMRequireError(parsedError: ESMRequireError, resolvedConfig: ReadConfigResult) {
  logger.log(
    `\n${chalkError("X Error:")} The ${chalkPurple(
      parsedError.moduleName
    )} module is being required even though it's ESM only, and builds only support CommonJS. There are two ${chalk.underline(
      "possible"
    )} ways to fix this:`
  );
  logger.log(
    `\n${chalkGrey("○")} Dynamically import the module in your code: ${chalkGrey(
      `const myModule = await import("${parsedError.moduleName}");`
    )}`
  );

  if (resolvedConfig.status === "file") {
    const relativePath = relative(resolvedConfig.config.projectDir, resolvedConfig.path).replace(
      /\\/g,
      "/"
    );

    logger.log(
      `${chalkGrey("○")} ${chalk.underline("Or")} add ${chalkPurple(
        parsedError.moduleName
      )} to the ${chalkGreen("dependenciesToBundle")} array in your config file ${chalkGrey(
        `(${relativePath})`
      )}. This will bundle the module with your code.\n`
    );
  } else {
    logger.log(
      `${chalkGrey("○")} ${chalk.underline("Or")} add ${chalkPurple(
        parsedError.moduleName
      )} to the ${chalkGreen("dependenciesToBundle")} array in your config file ${chalkGrey(
        "(you'll need to create one)"
      )}. This will bundle the module with your code.\n`
    );
  }

  logger.log(
    `${chalkGrey("○")} For more info see the ${cliLink("relevant docs", docs.config.esm)}.\n`
  );
}

export type PackageNotFoundError = {
  type: "package-not-found-error";
  packageName: string;
};

export type NoMatchingVersionError = {
  type: "no-matching-version-error";
  packageName: string;
};

export type NpmInstallError = PackageNotFoundError | NoMatchingVersionError | string;

export function parseNpmInstallError(error: unknown): NpmInstallError {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    if (typeof error.stack === "string") {
      const isPackageNotFoundError =
        error.stack.includes("ERR! 404 Not Found") &&
        error.stack.includes("is not in this registry");
      let packageName = null;

      if (isPackageNotFoundError) {
        // Regular expression to match the package name
        const packageNameRegex = /'([^']+)' is not in this registry/;
        const match = packageNameRegex.exec(error.stack);
        if (match) {
          packageName = match[1] as string; // Capture the package name
        }
      }

      if (packageName) {
        return {
          type: "package-not-found-error",
          packageName,
        };
      }

      const noMatchingVersionRegex = /No matching version found for ([^\s]+)\s/;
      const noMatchingVersionMatch = noMatchingVersionRegex.exec(error.stack);
      if (noMatchingVersionMatch) {
        return {
          type: "no-matching-version-error",
          packageName: (noMatchingVersionMatch[1] as string).replace(/.$/, ""),
        };
      }

      return error.message;
    } else {
      return error.message;
    }
  }

  return "Unknown error";
}

export function logTaskMetadataParseError(zodIssues: z.ZodIssue[], tasks: any) {
  logger.log(
    `\n${chalkError("X Error:")} Failed to start. The following ${
      zodIssues.length === 1 ? "task issue was" : "task issues were"
    } found:`
  );

  const groupedIssues = groupTaskMetadataIssuesByTask(tasks, zodIssues);

  for (const key in groupedIssues) {
    const taskWithIssues = groupedIssues[key];

    if (!taskWithIssues) {
      continue;
    }

    logger.log(
      `\n  ${chalkWarning("❯")} ${taskWithIssues.exportName} ${chalkGrey("in")} ${
        taskWithIssues.filePath
      }`
    );

    for (const issue of taskWithIssues.issues) {
      if (issue.path) {
        logger.log(`    ${chalkError("x")} ${issue.path} ${chalkGrey(issue.message)}`);
      } else {
        logger.log(`    ${chalkError("x")} ${chalkGrey(issue.message)}`);
      }
    }
  }
}
