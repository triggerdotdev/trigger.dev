import picomatch from "picomatch/posix.js";
import { z } from "zod";

export const BranchTrackingConfigSchema = z.object({
  prod: z.object({
    branch: z.string().optional(),
  }),
  staging: z.object({
    branch: z.string().optional(),
  }),
});

export type BranchTrackingConfig = z.infer<typeof BranchTrackingConfigSchema>;

export const BuildFiltersSchema = z.object({
  ignorePaths: z.array(z.string()),
});

export type BuildFilters = z.infer<typeof BuildFiltersSchema>;

export type IgnorePathLimits = { maxPaths: number; maxLength: number };

export function ignorePathError(pattern: string, maxLength: number): string | undefined {
  if (pattern.length > maxLength) {
    return `Use at most ${maxLength} characters.`;
  }
  const { negated, negatedExtglob, base } = picomatch.scan(pattern);
  if (negated || negatedExtglob) {
    return "Negated patterns aren't supported. List only the paths to ignore.";
  }
  if (base.startsWith("/")) {
    return "Start from the repository root, without a leading slash.";
  }
  const unescaped = pattern.replace(/\\\//g, "/").replace(/\\./g, "");
  if (/[{}]/.test(unescaped)) {
    return "Braces aren't supported. Put each alternative on its own line.";
  }
  if (/[()|]/.test(unescaped)) {
    return "Escape ( ) and | with a backslash to match them, like app/\\(marketing\\)/**.";
  }
  if (unescaped.includes("[!")) {
    return "Use [^...] to exclude characters, like [^_].";
  }
  // More wildcards than this make matching slow enough to stall webhook handling.
  const segments = unescaped.split("/");
  if (segments.filter((segment) => segment === "**").length > 2) {
    return "Use ** at most twice.";
  }
  if (
    segments
      .filter((segment) => segment !== "**")
      .join("/")
      .split("*").length > 3
  ) {
    return "Use * at most twice, apart from **.";
  }
  if (pattern.endsWith("/")) {
    const suggestion = pattern.endsWith("**/") ? pattern.slice(0, -1) : `${pattern}**`;
    return `Matches no files. Use ${suggestion} for everything in the directory.`;
  }
  try {
    // Without debug, makeRe returns a never-matching regex instead of throwing.
    picomatch.makeRe(pattern, { debug: true });
  } catch {
    return "Not a valid glob pattern.";
  }
  return undefined;
}

function splitIgnorePaths(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ignorePathsSchema({ maxPaths, maxLength }: IgnorePathLimits) {
  return z
    .string()
    .optional()
    .transform((text) => splitIgnorePaths(text ?? ""))
    .superRefine((patterns, ctx) => {
      if (patterns.length > maxPaths) {
        ctx.addIssue({ code: "custom", message: `Add at most ${maxPaths} paths.` });
      }
      for (const pattern of patterns) {
        const message = ignorePathError(pattern, maxLength);
        if (message) ctx.addIssue({ code: "custom", message: `${pattern}: ${message}` });
      }
    });
}

export function getTrackedBranchForEnvironment(
  branchTracking: BranchTrackingConfig | undefined,
  previewDeploymentsEnabled: boolean,
  environment: {
    type: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
    branchName?: string;
  }
): string | undefined {
  switch (environment.type) {
    case "PRODUCTION":
      return branchTracking?.prod?.branch;
    case "STAGING":
      return branchTracking?.staging?.branch;
    case "PREVIEW":
      return previewDeploymentsEnabled ? environment.branchName : undefined;
    case "DEVELOPMENT":
      return undefined;
    default:
      environment.type satisfies never;
      return undefined;
  }
}
