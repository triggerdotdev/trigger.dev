import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { tryCatch } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";
import { makeExternalRegexp } from "./externals.js";

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

export type SourceScanResult = {
  specifiers: CreateRequireSpecifier[];
  /** Names of require functions this file creates and exports (`export const req = createRequire(...)`) */
  exportedRequireFns: string[];
};

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const STRING_LITERAL = `(["'])([^"'\\n]+)\\1`;
const NESTED_CALL_ARGS = `(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*`;
const MODULE_SPECIFIER = `["'](?:node:)?module["']`;
const MODULE_LOAD = `(?:await\\s+)?(?:require|import)\\s*\\(\\s*${MODULE_SPECIFIER}\\s*\\)`;

/**
 * Finds string-literal package specifiers loaded through `createRequire`, e.g.
 * `createRequire(import.meta.url)("mssql")` or
 * `const req = createRequire(import.meta.url); req("mssql")`.
 *
 * esbuild treats `createRequire` as an opaque call: nothing it loads is ever
 * resolved, so such packages are neither bundled nor collected as externals
 * and are missing from deployed images. Scanning runs on a lexed copy of the
 * source (comments, template text and regex literals blanked, string spans
 * excluded from matching) and only recognizes createRequire bindings that
 * actually come from the `module` builtin. Still a best-effort heuristic:
 * computed or template-literal specifiers and re-exported createRequire are
 * not detected.
 */
export function scanSourceForCreateRequire(
  source: string,
  knownRequireFnExports?: ReadonlySet<string>
): CreateRequireSpecifier[] {
  return scanSource(source, knownRequireFnExports).specifiers;
}

export function scanSource(
  source: string,
  knownRequireFnExports?: ReadonlySet<string>
): SourceScanResult {
  const empty: SourceScanResult = { specifiers: [], exportedRequireFns: [] };

  const mentionsKnownExport = knownRequireFnExports
    ? Array.from(knownRequireFnExports).some((name) => source.includes(name))
    : false;

  if (!source.includes("createRequire") && !mentionsKnownExport) {
    return empty;
  }

  const { code, stringSpans } = lexSource(source);

  const inString = (index: number) =>
    stringSpans.some(([start, end]) => index >= start && index < end);

  const requireFnNames = new Set<string>();
  const exportedRequireFns = new Set<string>();
  const specifiers: CreateRequireSpecifier[] = [];
  const seen = new Set<string>();

  const pushHit = (index: number, specifier: string) => {
    const key = `${index}:${specifier}`;

    if (seen.has(key) || inString(index) || !isWarnableSpecifier(specifier)) {
      return;
    }

    seen.add(key);
    specifiers.push({ specifier, ...locationAt(source, index) });
  };

  const { aliases, namespaces } = collectCreateRequireBindings(code, inString);

  if (aliases.size > 0 || namespaces.size > 0) {
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

    const directCallRegex = new RegExp(
      `(?<![.\\w$])${createRequireCall}\\s*\\(\\s*${STRING_LITERAL}\\s*\\)`,
      "g"
    );

    for (const match of code.matchAll(directCallRegex)) {
      pushHit(match.index!, match[2]!);
    }

    const assignmentRegex = new RegExp(
      `(?<![.\\w$])(?:(export)\\s+)?(?:(?:const|let|var)\\s+)?(${IDENTIFIER})\\s*(?::\\s*[^=\\n;]+?)?\\s*=\\s*${createRequireCall}(?!\\s*[(=])`,
      "g"
    );

    for (const match of code.matchAll(assignmentRegex)) {
      if (inString(match.index!)) {
        continue;
      }

      requireFnNames.add(match[2]!);

      if (match[1]) {
        exportedRequireFns.add(match[2]!);
      }
    }
  }

  if (knownRequireFnExports && knownRequireFnExports.size > 0) {
    const relativeImportRegex = new RegExp(
      `import\\s*(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["'](\\.[^"'\\n]*)["']`,
      "g"
    );

    for (const match of code.matchAll(relativeImportRegex)) {
      if (inString(match.index!)) {
        continue;
      }

      for (const binding of match[1]!.split(",")) {
        const bindingMatch = binding.match(
          new RegExp(`^\\s*(${IDENTIFIER})\\s*(?:as\\s+(${IDENTIFIER}))?\\s*$`)
        );

        if (bindingMatch && knownRequireFnExports.has(bindingMatch[1]!)) {
          requireFnNames.add(bindingMatch[2] ?? bindingMatch[1]!);
        }
      }
    }
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

  specifiers.sort((a, b) => a.line - b.line || a.column - b.column);

  return { specifiers, exportedRequireFns: Array.from(exportedRequireFns) };
}

type CreateRequireBindings = {
  /** Local names bound to createRequire itself (named import or destructure) */
  aliases: Set<string>;
  /** Local names bound to the module builtin's namespace or default export */
  namespaces: Set<string>;
};

function collectCreateRequireBindings(
  code: string,
  inString: (index: number) => boolean
): CreateRequireBindings {
  const aliases = new Set<string>();
  const namespaces = new Set<string>();

  const namedBindingRegexes = [
    new RegExp(
      `import\\s*(?:type\\s+)?(?:(${IDENTIFIER})\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*${MODULE_SPECIFIER}`,
      "g"
    ),
    new RegExp(`(?:const|let|var)\\s*()\\{([^}]*)\\}\\s*=\\s*${MODULE_LOAD}`, "g"),
  ];

  for (const regex of namedBindingRegexes) {
    for (const match of code.matchAll(regex)) {
      if (inString(match.index!)) {
        continue;
      }

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
    new RegExp(`(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*${MODULE_LOAD}`, "g"),
  ];

  for (const regex of namespaceBindingRegexes) {
    for (const match of code.matchAll(regex)) {
      if (!inString(match.index!)) {
        namespaces.add(match[1]!);
      }
    }
  }

  return { aliases, namespaces };
}

type LexedSource = {
  /** Source with comments, template text and regex-literal bodies blanked (offsets preserved) */
  code: string;
  /** Spans (start inclusive, end exclusive) of single/double-quoted strings, quotes included */
  stringSpans: Array<[number, number]>;
};

/**
 * Blanks out comments, template-literal text (interpolation code is kept) and
 * regex-literal bodies while preserving every character offset and newline,
 * and records the spans of single/double-quoted strings. Regex scanning then
 * never matches inside a comment, a code snippet embedded in a template
 * string, or a regex literal, and matches inside quoted strings can be
 * rejected by span. Quoted string contents are kept in the output because
 * specifier literals must stay extractable. Regex-vs-division detection uses
 * the standard preceding-token heuristic and can misread rare forms.
 */
function lexSource(source: string): LexedSource {
  const out = source.split("");
  const stringSpans: Array<[number, number]> = [];
  const interpolationBraceDepths: number[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let inCharClass = false;
  let stringStart = 0;
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
        } else if (c === "/" && regexLiteralAllowedAt(source, i)) {
          mode = "regex";
          inCharClass = false;
          i += 1;
        } else if (c === "'") {
          mode = "single";
          stringStart = i;
          i += 1;
        } else if (c === '"') {
          mode = "double";
          stringStart = i;
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
          if (c === (mode === "single" ? "'" : '"')) {
            stringSpans.push([stringStart, i + 1]);
            mode = "code";
          } else if (c === "\n") {
            stringSpans.push([stringStart, i]);
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
      case "regex": {
        if (c === "\\") {
          blank(i);
          blank(i + 1);
          i += 2;
        } else if (c === "[") {
          inCharClass = true;
          blank(i);
          i += 1;
        } else if (c === "]") {
          inCharClass = false;
          blank(i);
          i += 1;
        } else if (c === "/" && !inCharClass) {
          mode = "code";
          i += 1;
        } else if (c === "\n") {
          mode = "code";
          i += 1;
        } else {
          blank(i);
          i += 1;
        }
        break;
      }
    }
  }

  if (mode === "single" || mode === "double") {
    stringSpans.push([stringStart, source.length]);
  }

  return { code: out.join(""), stringSpans };
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "case",
  "yield",
  "await",
]);

function regexLiteralAllowedAt(source: string, index: number): boolean {
  let j = index - 1;

  while (j >= 0 && /\s/.test(source[j]!)) {
    j--;
  }

  if (j < 0) {
    return true;
  }

  const prev = source[j]!;

  if (/[\w$]/.test(prev)) {
    let start = j;

    while (start > 0 && /[\w$]/.test(source[start - 1]!)) {
      start--;
    }

    return REGEX_PRECEDING_KEYWORDS.has(source.slice(start, j + 1));
  }

  return !/[)\]"'`.]/.test(prev);
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

type CollectorCacheEntry = {
  mtimeMs: number;
  size: number;
  exportedRequireFns: string[];
  knownsSignature: string;
  specifiers: CreateRequireSpecifier[];
};

/**
 * Scans the bundle's input files for packages loaded through `createRequire`.
 * Only files outside `node_modules` are scanned: bundled libraries commonly
 * use optional-require patterns that would drown real findings in noise.
 * Require functions exported from one scanned file and imported (by name,
 * from a relative path) into another are followed. Scan results are cached
 * per file by mtime and size so dev rebuilds only re-read changed files.
 */
export class CreateRequireCollector {
  private _usages: CreateRequireUsage[] = [];
  private _cache = new Map<string, CollectorCacheEntry>();
  private _plugin: esbuild.Plugin | undefined;

  constructor(private readonly workingDir: string) {}

  get usages(): ReadonlyArray<CreateRequireUsage> {
    return this._usages;
  }

  get plugin(): esbuild.Plugin {
    this._plugin ??= {
      name: "create-require-collector",
      setup: (build) => {
        build.onEnd(async (result) => {
          this._usages = [];

          if (!result.metafile) {
            return;
          }

          try {
            await this.collect(result.metafile);
          } catch (error) {
            logger.debug("[createRequire] Scan failed; skipping warnings", { error });
            this._usages = [];
          }
        });
      },
    };

    return this._plugin;
  }

  private async collect(metafile: esbuild.Metafile): Promise<void> {
    const files: Array<{ inputPath: string; filePath: string }> = [];

    for (const inputPath of Object.keys(metafile.inputs)) {
      const cleanPath = inputPath.split("?")[0]!;

      if (!SCANNABLE_FILE_REGEX.test(cleanPath) || NODE_MODULES_SEGMENT_REGEX.test(cleanPath)) {
        continue;
      }

      files.push({
        inputPath: cleanPath,
        filePath: isAbsolute(cleanPath) ? cleanPath : resolve(this.workingDir, cleanPath),
      });
    }

    const scanned = await Promise.all(
      files.map(async ({ inputPath, filePath }) => {
        const [statError, stats] = await tryCatch(stat(filePath));

        if (statError) {
          logger.debug("[createRequire] Unable to stat bundle input file", {
            filePath,
            error: statError,
          });

          return undefined;
        }

        const cached = this._cache.get(filePath);
        const unchanged =
          cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;

        let source: string | undefined;

        if (!unchanged) {
          const [readError, contents] = await tryCatch(readFile(filePath, "utf8"));

          if (readError) {
            logger.debug("[createRequire] Unable to read bundle input file", {
              filePath,
              error: readError,
            });

            return undefined;
          }

          source = contents;
        }

        return { inputPath, filePath, stats, cached: unchanged ? cached : undefined, source };
      })
    );

    const exportedRequireFns = new Set<string>();

    const withExports = scanned
      .filter((entry) => entry !== undefined)
      .map((entry) => {
        const exported =
          entry.cached?.exportedRequireFns ?? scanSource(entry.source!).exportedRequireFns;

        for (const name of exported) {
          exportedRequireFns.add(name);
        }

        return { ...entry, exportedRequireFns: exported };
      });

    const knownsSignature = Array.from(exportedRequireFns).sort().join(",");

    for (const entry of withExports) {
      let specifiers: CreateRequireSpecifier[];

      if (entry.cached && entry.cached.knownsSignature === knownsSignature) {
        specifiers = entry.cached.specifiers;
      } else {
        const source =
          entry.source ?? (await tryCatch(readFile(entry.filePath, "utf8")))[1] ?? undefined;

        if (source === undefined) {
          continue;
        }

        specifiers = scanSource(source, exportedRequireFns).specifiers;

        this._cache.set(entry.filePath, {
          mtimeMs: entry.stats.mtimeMs,
          size: entry.stats.size,
          exportedRequireFns: entry.exportedRequireFns,
          knownsSignature,
          specifiers,
        });
      }

      for (const found of specifiers) {
        this._usages.push({
          ...found,
          file: entry.inputPath,
          packageName: packageNameForSpecifier(found.specifier),
        });
      }
    }
  }
}

export type ExtensionInstalledPackages = {
  matchers: RegExp[];
  /**
   * True when what extensions install can't be fully determined (an extension
   * hook threw, or an additionalPackages extension predates the
   * installedPackagesForTarget hook). Dev-mode warnings must stay silent in
   * that case rather than risk false "deploys will fail" claims; deploy-mode
   * warnings are unaffected because the manifest externals are the truth
   * there.
   */
  incomplete: boolean;
};

/**
 * Package-name matchers for everything the configured build extensions
 * install into or externalize for the deployed image. Never throws:
 * diagnostics must not fail a build.
 */
export function extensionInstalledPackageMatchers(
  config: ResolvedConfig
): ExtensionInstalledPackages {
  const matchers: RegExp[] = [];
  let incomplete = false;

  for (const buildExtension of config.build?.extensions ?? []) {
    try {
      const declared = [
        ...(buildExtension.installedPackagesForTarget?.("deploy") ?? []),
        ...(buildExtension.externalsForTarget?.("deploy") ?? []),
      ];

      for (const packageName of declared) {
        matchers.push(makeExternalRegexp(packageName));
      }

      if (
        buildExtension.name === "additionalPackages" &&
        typeof buildExtension.installedPackagesForTarget !== "function"
      ) {
        incomplete = true;
      }
    } catch (error) {
      logger.debug("[createRequire] Build extension package declaration failed", {
        extension: buildExtension.name,
        error,
      });

      incomplete = true;
    }
  }

  return { matchers, incomplete };
}

/**
 * Filters collected usages down to the ones that will actually be missing at
 * runtime in the deployed image: not in the resolved externals (the installed
 * dependencies) and not declared as installed by a build extension.
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

/**
 * The shared dev/deploy warning pipeline: suppress usages that will be
 * available in the image, render the rest. Returns [] instead of throwing on
 * any internal failure, and stays silent for dev when extension-installed
 * packages can't be determined (see ExtensionInstalledPackages.incomplete).
 */
export function collectCreateRequireWarningMessages({
  usages,
  buildManifest,
  extensionPackages,
  target,
}: {
  usages: ReadonlyArray<CreateRequireUsage>;
  buildManifest: BuildManifest;
  extensionPackages: ExtensionInstalledPackages;
  target: BuildTarget;
}): esbuild.PartialMessage[] {
  try {
    if (target === "dev" && extensionPackages.incomplete) {
      return [];
    }

    const installedPackages = new Set(
      (buildManifest.externals ?? []).map((external) => external.name)
    );

    return unavailableCreateRequireUsages(
      usages,
      installedPackages,
      extensionPackages.matchers
    ).map((usage) => createRequireUsageToWarning(usage, target));
  } catch (error) {
    logger.debug("[createRequire] Warning generation failed; skipping", { error });

    return [];
  }
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

Alternatively, replace the createRequire() call with a static import so the package is bundled. If this load is intentionally optional (guarded by try/catch with a fallback), you can ignore this warning. Docs: https://trigger.dev/docs/config/extensions/additionalPackages`,
      },
    ],
  };
}
