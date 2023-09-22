import fs from "fs/promises";
import { pathExists } from "../../utils/fileSystem";
import pathModule from "path";
import { logger } from "../../utils/logger";
import { telemetryClient } from "../../telemetry/telemetry";
import { pathToRegexp } from "path-to-regexp";

export async function detectMiddlewareUsage(path: string, usesSrcDir = false) {
  const middlewarePath = pathModule.join(path, usesSrcDir ? "src" : "", "middleware.ts");

  const middlewareExists = await pathExists(middlewarePath);

  if (!middlewareExists) {
    return;
  }

  const matcher = await getMiddlewareConfigMatcher(middlewarePath);

  if (!matcher || matcher.length === 0) {
    logger.warn(
      `⚠️ ⚠️ ⚠️  It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
        process.cwd(),
        middlewarePath
      )} which can cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
    );

    telemetryClient.init.warning("middleware_conflict", { projectPath: path });
    return;
  }

  if (matcher.length === 0) {
    return;
  }

  if (typeof matcher === "string") {
    const matcherRegex = pathToRegexp(matcher);

    // Check to see if /api/trigger matches the regex, if it does, then we need to output a warning with a link to the docs to fix it
    if (matcherRegex.test("/api/trigger")) {
      logger.warn(
        `🚨 It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
          process.cwd(),
          middlewarePath
        )} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
      );
      telemetryClient.init.warning("middleware_conflict_api_trigger", { projectPath: path });
    }
  } else if (Array.isArray(matcher) && matcher.every((m) => typeof m === "string")) {
    const matcherRegexes = matcher.map((m) => pathToRegexp(m));

    if (matcherRegexes.some((r) => r.test("/api/trigger"))) {
      logger.warn(
        `🚨 It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
          process.cwd(),
          middlewarePath
        )} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
      );
      telemetryClient.init.warning("middleware_conflict", { projectPath: path });
    }
  }
}

async function getMiddlewareConfigMatcher(path: string): Promise<Array<string>> {
  const fileContent = await fs.readFile(path, "utf-8");

  const regex = /matcher:\s*(\[.*\]|".*")/s;
  let match = regex.exec(fileContent);

  if (!match) {
    return [];
  }

  if (match.length < 2) {
    return [];
  }

  let matcherString: string = match[1] as string;

  // Handle array scenario
  if (matcherString.startsWith("[") && matcherString.endsWith("]")) {
    matcherString = matcherString.slice(1, -1); // Remove brackets
    const arrayRegex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
    let arrayMatch;
    const matches: string[] = [];
    while ((arrayMatch = arrayRegex.exec(matcherString)) !== null) {
      matches.push((arrayMatch[1] as string).slice(1, -1)); // remove quotes
    }
    return matches;
  } else {
    // Handle single string scenario
    return [matcherString.slice(1, -1)]; // remove quotes
  }
}
