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
  ignorePaths: z.array(z.string()).catch([]),
  ignoreBranches: z.array(z.string()).catch([]),
});

export type BuildFilters = z.infer<typeof BuildFiltersSchema>;

export type IgnoreKind = "paths" | "branches";

export type IgnorePatternLimits = { maxPatterns: number; maxLength: number };

const ignoreKindMessages = {
  paths: {
    noun: "paths",
    negated: "Negated patterns aren't supported. List only the paths to ignore.",
    leadingSlash: "Start from the repository root, without a leading slash.",
    groups: "Escape ( ) and | with a backslash to match them, like app/\\(marketing\\)/**.",
    trailingSlash: (suggestion: string) =>
      `Matches no files. Use ${suggestion} for everything in the directory.`,
  },
  branches: {
    noun: "branches",
    negated: "Negated patterns aren't supported. List only the branches to ignore.",
    leadingSlash: "Branch names never start with a slash.",
    groups:
      "Groups aren't supported. Put each alternative on its own line, or escape ( ) and | with a backslash to match them.",
    trailingSlash: (suggestion: string) =>
      `Branch names never end with a slash. Use ${suggestion} instead.`,
  },
} satisfies Record<IgnoreKind, unknown>;

export function tooManyIgnorePatterns(kind: IgnoreKind, maxPatterns: number): string {
  return `Add at most ${maxPatterns} ${ignoreKindMessages[kind].noun}.`;
}

export function ignorePatternError(
  kind: IgnoreKind,
  pattern: string,
  maxLength: number
): string | undefined {
  const messages = ignoreKindMessages[kind];
  if (pattern.length > maxLength) {
    return `Use at most ${maxLength} characters.`;
  }
  const { negated, negatedExtglob, base } = picomatch.scan(pattern);
  if (negated || negatedExtglob) {
    return messages.negated;
  }
  if (base.startsWith("/")) {
    return messages.leadingSlash;
  }
  if (kind === "branches" && pattern.startsWith("refs/heads/")) {
    return "Use the branch name without refs/heads/.";
  }
  const unescaped = pattern.replace(/\\\//g, "/").replace(/\\./g, "");
  if (/[{}]/.test(unescaped)) {
    return "Braces aren't supported. Put each alternative on its own line.";
  }
  if (/[()|]/.test(unescaped)) {
    return messages.groups;
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
    return messages.trailingSlash(suggestion);
  }
  try {
    // Without debug, makeRe returns a never-matching regex instead of throwing.
    picomatch.makeRe(pattern, { debug: true });
  } catch {
    return "Not a valid glob pattern.";
  }
  return undefined;
}

function splitIgnorePatterns(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function ignorePatternsSchema(
  kind: IgnoreKind,
  { maxPatterns, maxLength }: IgnorePatternLimits
) {
  return z
    .string()
    .optional()
    .transform((text) => splitIgnorePatterns(text ?? ""))
    .superRefine((patterns, ctx) => {
      if (patterns.length > maxPatterns) {
        ctx.addIssue({ code: "custom", message: tooManyIgnorePatterns(kind, maxPatterns) });
      }
      for (const pattern of patterns) {
        const message = ignorePatternError(kind, pattern, maxLength);
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
