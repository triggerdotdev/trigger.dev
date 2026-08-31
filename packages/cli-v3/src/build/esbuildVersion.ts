import * as semver from "semver";

/**
 * The esbuild range the CLI declares in its package.json.
 *
 * Kept in sync manually: a package manager `overrides`/`resolutions` entry can
 * install a version outside this range without any warning, which is exactly
 * the case this module exists to catch.
 */
export const SUPPORTED_ESBUILD_RANGE = "^0.23.0";

export type EsbuildVersionIssue = {
  level: "error" | "warning";
  message: string;
};

type KnownBadRange = {
  /** Versions known to miscompile in a way that breaks deployed workers. */
  range: string;
  /** First release containing the fix. */
  fixedIn: string;
  summary: string;
};

/**
 * Versions we refuse to build with, rather than merely warn about, because the
 * output is silently corrupt and only fails at runtime inside a deployed task.
 */
const KNOWN_BAD_RANGES: KnownBadRange[] = [
  {
    range: "0.25.0",
    fixedIn: "0.25.1",
    summary:
      "emits sourcemaps whose mappings reference input `sources` entries that were dropped, so `source-map-support` throws `No element indexed by N` the first time a stack trace touches an affected chunk",
  },
];

/**
 * Check the esbuild version actually resolved at runtime — not the range the
 * CLI declares — and report anything that will produce a broken build.
 *
 * Returns `undefined` when the version is fine.
 */
export function checkEsbuildVersion(version: string): EsbuildVersionIssue | undefined {
  const parsed = semver.valid(semver.coerce(version));

  if (!parsed) {
    // An unparseable version is not worth failing a build over; the caller has
    // nothing actionable to say about it.
    return undefined;
  }

  const knownBad = KNOWN_BAD_RANGES.find((candidate) =>
    semver.satisfies(parsed, candidate.range, { includePrerelease: true })
  );

  if (knownBad) {
    return {
      level: "error",
      message: [
        `esbuild ${version} is known to produce corrupt builds and cannot be used.`,
        "",
        `It ${knownBad.summary}.`,
        "",
        `Fixed in esbuild ${knownBad.fixedIn}. The Trigger.dev CLI expects esbuild ${SUPPORTED_ESBUILD_RANGE}.`,
        "",
        "This usually means a package manager `overrides`, `resolutions` or `pnpm.overrides` entry",
        "pinned esbuild across your whole dependency tree. Remove the pin, or raise it to a fixed",
        `version (>= ${knownBad.fixedIn}), and reinstall.`,
      ].join("\n"),
    };
  }

  if (!semver.satisfies(parsed, SUPPORTED_ESBUILD_RANGE, { includePrerelease: true })) {
    return {
      level: "warning",
      message: [
        `esbuild ${version} is outside the range the Trigger.dev CLI is tested against (${SUPPORTED_ESBUILD_RANGE}).`,
        "This is usually caused by a package manager `overrides` or `resolutions` entry.",
        "If you hit unexpected build output or broken stack traces, try removing the pin first.",
      ].join("\n"),
    };
  }

  return undefined;
}
