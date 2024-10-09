import { log } from "@clack/prompts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chalkError, chalkWarning, cliLink } from "../utilities/cliOutput.js";
import { createTempDir } from "../utilities/fileSystem.js";
import { links } from "@trigger.dev/core/v3";

export type WarningsCheckReturn =
  | {
      ok: true;
      warnings: string[];
    }
  | {
      ok: false;
      summary: string;
      errors: string[];
      warnings: string[];
    };

export type LogParserOptions = Array<{
  regex: RegExp;
  message: string;
  shouldFail?: boolean;
}>;

export async function saveLogs(shortCode: string, logs: string) {
  const logPath = join(await createTempDir(), `build-${shortCode}.log`);
  await writeFile(logPath, logs);
  return logPath;
}

export function printErrors(errors?: string[]) {
  for (const error of errors ?? []) {
    log.error(`${chalkError("Error:")} ${error}`);
  }
}

export function printWarnings(warnings?: string[]) {
  for (const warning of warnings ?? []) {
    log.warn(`${chalkWarning("Warning:")} ${warning}`);
  }
}

// Try to extract useful error messages from the logs
export function checkLogsForErrors(logs: string) {
  const errors: LogParserOptions = [
    {
      regex: /Error: Provided --schema at (?<schema>.*) doesn't exist/,
      message: `Prisma generate failed to find the specified schema at "$schema".\nDid you configure the Prisma extension correctly? ${cliLink(
        "Extension docs",
        links.docs.config.prisma
      )}`,
    },
    {
      regex: /@prisma\/client did not initialize yet/,
      message: `Prisma client not initialized yet.\nDid you configure the Prisma extension? ${cliLink(
        "Extension docs",
        links.docs.config.prisma
      )}`,
    },
    {
      regex: /sh: 1: (?<packageOrBinary>.*): not found/,
      message: `$packageOrBinary not found\n\nIf it's a package: Use the ${cliLink(
        "additionalPackages extension",
        links.docs.config.additionalPackages
      )}\nIf it's a binary:  Check the other ${cliLink(
        "build extensions",
        links.docs.config.extensions
      )}`,
    },
  ];

  for (const error of errors) {
    const matches = logs.match(error.regex);

    if (!matches) {
      continue;
    }

    const message = getMessageFromTemplate(error.message, matches.groups);

    log.error(`${chalkError("Error:")} ${message}`);
    break;
  }
}

function getMessageFromTemplate(template: string, replacer: RegExpMatchArray["groups"]) {
  let message = template;

  if (replacer) {
    for (const [key, value] of Object.entries(replacer)) {
      message = message.replaceAll(`$${key}`, value);
    }
  }

  return message;
}

// Try to extract useful warnings from logs. Sometimes we may even want to fail the build. This won't work if the step is cached.
export function checkLogsForWarnings(logs: string): WarningsCheckReturn {
  const warnings: LogParserOptions = [
    {
      regex: /prisma:warn We could not find your Prisma schema/,
      message: `Prisma generate failed to find the default schema. Did you configure the Prisma extension correctly? ${cliLink(
        "Extension docs",
        links.docs.config.prisma
      )}`,
      shouldFail: true,
    },
  ];

  const errorMessages: string[] = [];
  const warningMessages: string[] = [];

  let shouldFail = false;

  for (const warning of warnings) {
    const matches = logs.match(warning.regex);

    if (!matches) {
      continue;
    }

    const message = getMessageFromTemplate(warning.message, matches.groups);

    if (warning.shouldFail) {
      shouldFail = true;
      errorMessages.push(message);
    } else {
      warningMessages.push(message);
    }
  }

  if (shouldFail) {
    return {
      ok: false,
      summary: "Build succeeded with critical warnings. Will not proceed",
      warnings: warningMessages,
      errors: errorMessages,
    };
  }

  return {
    ok: true,
    warnings: warningMessages,
  };
}
