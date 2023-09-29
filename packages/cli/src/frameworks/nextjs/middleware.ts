import fs from "fs/promises";
import { pathExists } from "../../utils/fileSystem";
import pathModule from "path";
import { logger } from "../../utils/logger";
import { telemetryClient } from "../../telemetry/telemetry";
import { pathToRegexp } from "path-to-regexp";
import { detectUseOfSrcDir } from ".";

type Result =
  | {
      hasMiddleware: false;
    }
  | {
      hasMiddleware: true;
      conflict: "unlikely" | "possible" | "likely";
      middlewarePath: string;
    };

export async function detectMiddlewareUsage(path: string, typescript: boolean): Promise<Result> {
  const usesSrcDir = await detectUseOfSrcDir(path);
  const middlewarePath = pathModule.join(
    path,
    usesSrcDir ? "src" : "",
    `middleware.${typescript ? "ts" : "js"}`
  );

  try {
    return await detectMiddleware(path, typescript, middlewarePath);
  } catch (e) {
    return {
      hasMiddleware: true,
      conflict: "possible",
      middlewarePath: pathModule.relative(process.cwd(), middlewarePath),
    };
  }
}

async function detectMiddleware(
  path: string,
  typescript: boolean,
  middlewarePath: string
): Promise<Result> {
  const middlewareExists = await pathExists(middlewarePath);
  if (!middlewareExists) {
    return { hasMiddleware: false };
  }

  const middlewareRelativeFilePath = pathModule.relative(process.cwd(), middlewarePath);

  const matcher = await getMiddlewareConfigMatcher(middlewarePath);

  if (!matcher || matcher.length === 0) {
    return {
      hasMiddleware: true,
      conflict: "possible",
      middlewarePath: middlewareRelativeFilePath,
    };
  }

  if (matcher.length === 0) {
    return {
      hasMiddleware: true,
      conflict: "unlikely",
      middlewarePath: middlewareRelativeFilePath,
    };
  }

  const matcherRegexes = matcher.map((m) => pathToRegexp(m));
  if (matcherRegexes.some((r) => r.test("/api/trigger"))) {
    return {
      hasMiddleware: true,
      conflict: "likely",
      middlewarePath: middlewareRelativeFilePath,
    };
  }

  return {
    hasMiddleware: true,
    conflict: "possible",
    middlewarePath: middlewareRelativeFilePath,
  };
}

async function getMiddlewareConfigMatcher(path: string): Promise<Array<string>> {
  const fileContent = await fs.readFile(path, "utf-8");

  const regex = /matcher:\s*(\[.*\]|["'].*["'])/g;
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
