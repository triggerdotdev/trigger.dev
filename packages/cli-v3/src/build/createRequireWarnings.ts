import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { tryCatch } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";

export type CreateRequireSpecifier = {
  specifier: string;
  /** 1-based, matching esbuild message locations */
  line: number;
  /** 0-based, matching esbuild message locations */
  column: number;
  lineText: string;
};

export type CreateRequireUsage = CreateRequireSpecifier & {
  file: string;
  packageName: string;
};

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const STRING_LITERAL = `(["'])([^"'\\n]+)\\1`;
const NESTED_CALL_ARGS = `(?:[^()]|\\([^()]*\\))*`;
const MODULE_IMPORT_REGEX = /(?:from\s*|require\(\s*|import\(\s*)["'](?:node:)?module["']/;

/**
 * Finds string-literal package specifiers loaded through `createRequire`, e.g.
 * `createRequire(import.meta.url)("mssql")` or
 * `const req = createRequire(import.meta.url); req("mssql")`.
 *
 * esbuild treats `createRequire` as an opaque call: nothing it loads is ever
 * resolved, so such packages are neither bundled nor collected as externals
 * and are missing from deployed images. This scan is a best-effort heuristic —
 * computed specifiers or a re-exported `createRequire` are not detected.
 */
export function scanSourceForCreateRequire(source: string): CreateRequireSpecifier[] {
  if (!source.includes("createRequire") || !MODULE_IMPORT_REGEX.test(source)) {
    return [];
  }

  const aliases = collectCreateRequireAliases(source);
  const aliasPattern = Array.from(aliases).map(escapeRegExp).join("|");
  const createRequireCall = `(?:${IDENTIFIER}\\s*\\.\\s*)?(?:${aliasPattern})\\s*\\(${NESTED_CALL_ARGS}\\)`;

  const results: CreateRequireSpecifier[] = [];
  const seen = new Set<string>();

  const pushHit = (index: number, specifier: string) => {
    const key = `${index}:${specifier}`;

    if (seen.has(key) || !isWarnableSpecifier(specifier)) {
      return;
    }

    const location = locationAt(source, index);

    if (isCommentedOut(location.lineText, location.column)) {
      return;
    }

    seen.add(key);
    results.push({ specifier, ...location });
  };

  const directCallRegex = new RegExp(
    `(?<![.\\w$])${createRequireCall}\\s*\\(\\s*${STRING_LITERAL}\\s*\\)`,
    "g"
  );

  for (const match of source.matchAll(directCallRegex)) {
    pushHit(match.index!, match[2]!);
  }

  const assignmentRegex = new RegExp(
    `(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*${createRequireCall}(?!\\s*\\()`,
    "g"
  );

  const requireFnNames = new Set<string>();

  for (const match of source.matchAll(assignmentRegex)) {
    requireFnNames.add(match[1]!);
  }

  for (const name of requireFnNames) {
    const callRegex = new RegExp(
      `(?<![.\\w$])${escapeRegExp(name)}(?:\\s*\\.\\s*resolve)?\\s*\\(\\s*${STRING_LITERAL}\\s*\\)`,
      "g"
    );

    for (const match of source.matchAll(callRegex)) {
      pushHit(match.index!, match[2]!);
    }
  }

  results.sort((a, b) => a.line - b.line || a.column - b.column);

  return results;
}

function collectCreateRequireAliases(source: string): Set<string> {
  const aliases = new Set<string>(["createRequire"]);

  const bindingRegexes = [
    new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["'](?:node:)?module["']`, "g"),
    new RegExp(
      `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*["'](?:node:)?module["']\\s*\\)`,
      "g"
    ),
  ];

  for (const regex of bindingRegexes) {
    for (const match of source.matchAll(regex)) {
      const aliasMatch = match[1]!.match(
        new RegExp(`createRequire\\s*(?:as\\s+|:\\s*)(${IDENTIFIER})`)
      );

      if (aliasMatch) {
        aliases.add(aliasMatch[1]!);
      }
    }
  }

  return aliases;
}

export function packageNameForSpecifier(specifier: string): string {
  const parts = specifier.split("/");

  if (specifier.startsWith("@")) {
    return parts.slice(0, 2).join("/");
  }

  return parts[0]!;
}

function isWarnableSpecifier(specifier: string): boolean {
  const nonPackagePrefixes = [".", "/", "~", "#", "file:", "data:", "node:"];

  if (nonPackagePrefixes.some((prefix) => specifier.startsWith(prefix))) {
    return false;
  }

  return !builtinModules.includes(packageNameForSpecifier(specifier));
}

/**
 * Line-level heuristic for hits inside comments (commented-out code is the
 * realistic false-positive source). A `//` or `/*` before the hit on the same
 * line, or a line shaped like a block-comment continuation, means skip.
 */
function isCommentedOut(lineText: string, column: number): boolean {
  const prefix = lineText.slice(0, column);

  if (prefix.includes("//") || prefix.includes("/*")) {
    return true;
  }

  return lineText.trimStart().startsWith("*");
}

function locationAt(
  source: string,
  index: number
): { line: number; column: number; lineText: string } {
  const before = source.slice(0, index);
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = source.indexOf("\n", index);

  return {
    line: (before.match(/\n/g)?.length ?? 0) + 1,
    column: index - lineStart,
    lineText: source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SCANNABLE_FILE_REGEX = /\.(?:m|c)?(?:j|t)sx?$/;

/**
 * Scans the bundle's input files for packages loaded through `createRequire`.
 * Only files outside `node_modules` are scanned: bundled libraries commonly
 * use optional-require patterns that would drown real findings in noise.
 */
export class CreateRequireCollector {
  private _usages: CreateRequireUsage[] = [];

  constructor(private readonly workingDir: string) {}

  get usages(): ReadonlyArray<CreateRequireUsage> {
    return this._usages;
  }

  get plugin(): esbuild.Plugin {
    return {
      name: "create-require-collector",
      setup: (build) => {
        build.onEnd(async (result) => {
          this._usages = [];

          if (!result.metafile) {
            return;
          }

          for (const inputPath of Object.keys(result.metafile.inputs)) {
            const cleanPath = inputPath.split("?")[0]!;

            if (!SCANNABLE_FILE_REGEX.test(cleanPath) || cleanPath.includes("node_modules")) {
              continue;
            }

            const filePath = isAbsolute(cleanPath)
              ? cleanPath
              : resolve(this.workingDir, cleanPath);

            const [readError, contents] = await tryCatch(readFile(filePath, "utf8"));

            if (readError) {
              logger.debug("[createRequire] Unable to read bundle input file", {
                inputPath,
                filePath,
                error: readError,
              });

              continue;
            }

            for (const found of scanSourceForCreateRequire(contents)) {
              this._usages.push({
                ...found,
                file: cleanPath,
                packageName: packageNameForSpecifier(found.specifier),
              });
            }
          }
        });
      },
    };
  }
}

export function createRequireUsageToWarning(usage: CreateRequireUsage): esbuild.PartialMessage {
  return {
    pluginName: "create-require-collector",
    text: `"${usage.specifier}" is loaded with createRequire() but won't be available in the deployed image, so loading it will fail at runtime. The bundler can't follow createRequire() calls, so "${usage.packageName}" is neither bundled into your code nor installed in the image.`,
    location: {
      file: usage.file,
      line: usage.line,
      column: usage.column,
      lineText: usage.lineText,
    },
    notes: [
      {
        text: `To fix this, install "${usage.packageName}" into the image by adding the additionalPackages build extension to your trigger.config.ts:

  import { additionalPackages } from "@trigger.dev/build/extensions/core";

  export default defineConfig({
    // ...
    build: {
      extensions: [additionalPackages({ packages: ["${usage.packageName}"] })],
    },
  });

Alternatively, import the package statically so it gets bundled. Docs: https://trigger.dev/docs/config/extensions/additionalPackages`,
      },
    ],
  };
}
