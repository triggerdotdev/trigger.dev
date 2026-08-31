import { BuildTarget } from "@trigger.dev/core/v3/schemas";
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
const NESTED_CALL_ARGS = `(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*`;
const MODULE_SPECIFIER = `["'](?:node:)?module["']`;

/**
 * Finds string-literal package specifiers loaded through `createRequire`, e.g.
 * `createRequire(import.meta.url)("mssql")` or
 * `const req = createRequire(import.meta.url); req("mssql")`.
 *
 * esbuild treats `createRequire` as an opaque call: nothing it loads is ever
 * resolved, so such packages are neither bundled nor collected as externals
 * and are missing from deployed images. Scanning runs on a comment-stripped
 * copy of the source and only recognizes createRequire bindings that actually
 * come from the `module` builtin. Still a best-effort heuristic: computed
 * specifiers or a re-exported `createRequire` are not detected.
 */
export function scanSourceForCreateRequire(source: string): CreateRequireSpecifier[] {
  if (!source.includes("createRequire")) {
    return [];
  }

  const code = stripCommentsAndTemplateText(source);
  const { aliases, namespaces } = collectCreateRequireBindings(code);

  if (aliases.size === 0 && namespaces.size === 0) {
    return [];
  }

  const callHeads: string[] = [];

  if (aliases.size > 0) {
    callHeads.push(`(?:${Array.from(aliases).map(escapeRegExp).join("|")})`);
  }

  if (namespaces.size > 0) {
    callHeads.push(
      `(?:${Array.from(namespaces).map(escapeRegExp).join("|")})\\s*\\.\\s*createRequire`
    );
  }

  const createRequireCall = `(?:${callHeads.join("|")})\\s*\\(${NESTED_CALL_ARGS}\\)`;

  const results: CreateRequireSpecifier[] = [];
  const seen = new Set<string>();

  const pushHit = (index: number, specifier: string) => {
    const key = `${index}:${specifier}`;

    if (seen.has(key) || !isWarnableSpecifier(specifier)) {
      return;
    }

    seen.add(key);
    results.push({ specifier, ...locationAt(source, index) });
  };

  const directCallRegex = new RegExp(
    `(?<![.\\w$])${createRequireCall}\\s*\\(\\s*${STRING_LITERAL}\\s*\\)`,
    "g"
  );

  for (const match of code.matchAll(directCallRegex)) {
    pushHit(match.index!, match[2]!);
  }

  const assignmentRegex = new RegExp(
    `(?:const|let|var)\\s+(${IDENTIFIER})\\s*(?::\\s*[^=\\n;]+?)?\\s*=\\s*${createRequireCall}(?!\\s*\\()`,
    "g"
  );

  const requireFnNames = new Set<string>();

  for (const match of code.matchAll(assignmentRegex)) {
    requireFnNames.add(match[1]!);
  }

  for (const name of requireFnNames) {
    const callRegex = new RegExp(
      `(?<![.\\w$])${escapeRegExp(name)}(?:\\s*\\.\\s*resolve)?\\s*\\(\\s*${STRING_LITERAL}\\s*\\)`,
      "g"
    );

    for (const match of code.matchAll(callRegex)) {
      pushHit(match.index!, match[2]!);
    }
  }

  results.sort((a, b) => a.line - b.line || a.column - b.column);

  return results;
}

type CreateRequireBindings = {
  /** Local names bound to createRequire itself (named import or destructure) */
  aliases: Set<string>;
  /** Local names bound to the module builtin's namespace or default export */
  namespaces: Set<string>;
};

function collectCreateRequireBindings(code: string): CreateRequireBindings {
  const aliases = new Set<string>();
  const namespaces = new Set<string>();

  const namedBindingRegexes = [
    new RegExp(
      `import\\s*(?:type\\s+)?(?:(${IDENTIFIER})\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*${MODULE_SPECIFIER}`,
      "g"
    ),
    new RegExp(
      `(?:const|let|var)\\s*()\\{([^}]*)\\}\\s*=\\s*require\\s*\\(\\s*${MODULE_SPECIFIER}\\s*\\)`,
      "g"
    ),
  ];

  for (const regex of namedBindingRegexes) {
    for (const match of code.matchAll(regex)) {
      if (match[1]) {
        namespaces.add(match[1]);
      }

      for (const binding of match[2]!.split(",")) {
        const bindingMatch = binding.match(
          new RegExp(`^\\s*createRequire\\s*(?:(?:as\\s+|:\\s*)(${IDENTIFIER}))?\\s*$`)
        );

        if (bindingMatch) {
          aliases.add(bindingMatch[1] ?? "createRequire");
        }
      }
    }
  }

  const namespaceBindingRegexes = [
    new RegExp(`import\\s+(${IDENTIFIER})\\s+from\\s*${MODULE_SPECIFIER}`, "g"),
    new RegExp(`import\\s*\\*\\s*as\\s+(${IDENTIFIER})\\s+from\\s*${MODULE_SPECIFIER}`, "g"),
    new RegExp(
      `(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*require\\s*\\(\\s*${MODULE_SPECIFIER}\\s*\\)`,
      "g"
    ),
  ];

  for (const regex of namespaceBindingRegexes) {
    for (const match of code.matchAll(regex)) {
      namespaces.add(match[1]!);
    }
  }

  return { aliases, namespaces };
}

/**
 * Blanks out comments and template-literal text (interpolation code is kept)
 * while preserving every character offset and newline, so regex scanning
 * never matches inside a comment or a code snippet embedded in a template
 * string, and locations computed on the result map 1:1 onto the original.
 * Single- and double-quoted string contents are kept because specifier
 * literals must stay extractable. Regex literals are not lexed (a rare
 * unescaped `//` inside one reads as a line comment).
 */
export function stripCommentsAndTemplateText(source: string): string {
  const out = source.split("");
  const interpolationBraceDepths: number[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let i = 0;

  const blank = (index: number) => {
    if (out[index] !== "\n") {
      out[index] = " ";
    }
  };

  while (i < source.length) {
    const c = source[i]!;
    const d = source[i + 1];

    switch (mode) {
      case "code": {
        if (c === "/" && d === "/") {
          mode = "line";
          blank(i);
          blank(i + 1);
          i += 2;
        } else if (c === "/" && d === "*") {
          mode = "block";
          blank(i);
          blank(i + 1);
          i += 2;
        } else if (c === "'") {
          mode = "single";
          i += 1;
        } else if (c === '"') {
          mode = "double";
          i += 1;
        } else if (c === "`") {
          mode = "template";
          i += 1;
        } else if (c === "{" && interpolationBraceDepths.length > 0) {
          interpolationBraceDepths[interpolationBraceDepths.length - 1]!++;
          i += 1;
        } else if (c === "}" && interpolationBraceDepths.length > 0) {
          const depth = interpolationBraceDepths[interpolationBraceDepths.length - 1]!;

          if (depth === 0) {
            interpolationBraceDepths.pop();
            mode = "template";
          } else {
            interpolationBraceDepths[interpolationBraceDepths.length - 1] = depth - 1;
          }

          i += 1;
        } else {
          i += 1;
        }
        break;
      }
      case "line": {
        if (c === "\n") {
          mode = "code";
        } else {
          blank(i);
        }
        i += 1;
        break;
      }
      case "block": {
        if (c === "*" && d === "/") {
          mode = "code";
          blank(i);
          blank(i + 1);
          i += 2;
        } else {
          blank(i);
          i += 1;
        }
        break;
      }
      case "single":
      case "double": {
        if (c === "\\") {
          i += 2;
        } else {
          if (c === (mode === "single" ? "'" : '"') || c === "\n") {
            mode = "code";
          }
          i += 1;
        }
        break;
      }
      case "template": {
        if (c === "\\") {
          blank(i);
          blank(i + 1);
          i += 2;
        } else if (c === "`") {
          mode = "code";
          i += 1;
        } else if (c === "$" && d === "{") {
          interpolationBraceDepths.push(0);
          mode = "code";
          i += 2;
        } else {
          blank(i);
          i += 1;
        }
        break;
      }
    }
  }

  return out.join("");
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
const NODE_MODULES_SEGMENT_REGEX = /(?:^|[\\/])node_modules[\\/]/;

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

            if (
              !SCANNABLE_FILE_REGEX.test(cleanPath) ||
              NODE_MODULES_SEGMENT_REGEX.test(cleanPath)
            ) {
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

/**
 * Filters collected usages down to the ones that will actually be missing at
 * runtime in the deployed image: not in the resolved externals (installed
 * dependencies) and not matching any configured external.
 */
export function unavailableCreateRequireUsages(
  usages: ReadonlyArray<CreateRequireUsage>,
  installedPackages: Set<string>,
  externalMatchers: RegExp[]
): CreateRequireUsage[] {
  return usages.filter(
    (usage) =>
      !installedPackages.has(usage.packageName) &&
      !externalMatchers.some(
        (matcher) => matcher.test(usage.packageName) || matcher.test(usage.specifier)
      )
  );
}

export function createRequireUsageToWarning(
  usage: CreateRequireUsage,
  target: BuildTarget
): esbuild.PartialMessage {
  const text =
    target === "dev"
      ? `"${usage.specifier}" is loaded with createRequire(). This works locally because your project's node_modules exists, but the package won't be available in the deployed image, so deploys of this code will fail at runtime. The bundler can't follow createRequire() calls, so "${usage.packageName}" is neither bundled into your code nor installed in the image.`
      : `"${usage.specifier}" is loaded with createRequire() but won't be available in the deployed image, so loading it will fail at runtime. The bundler can't follow createRequire() calls, so "${usage.packageName}" is neither bundled into your code nor installed in the image.`;

  return {
    pluginName: "create-require-collector",
    text,
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

Alternatively, replace the createRequire() call with a static import so the package is bundled. Docs: https://trigger.dev/docs/config/extensions/additionalPackages`,
      },
    ],
  };
}
