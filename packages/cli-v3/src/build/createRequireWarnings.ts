import { parse, ParserPlugin } from "@babel/parser";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest, BuildTarget } from "@trigger.dev/core/v3/schemas";
import * as esbuild from "esbuild";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import pLimit from "p-limit";
import { tryCatch } from "@trigger.dev/core/v3";
import { logger } from "../utilities/logger.js";
import {
  isBareModuleImport,
  isBuiltinModule,
  makeExternalRegexp,
  packageNameForImportPath,
} from "./externals.js";

export { packageNameForImportPath as packageNameForSpecifier } from "./externals.js";

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

/**
 * Finds string-literal package specifiers loaded through `createRequire`, e.g.
 * `createRequire(import.meta.url)("mssql")` or
 * `const req = createRequire(import.meta.url); req("mssql")`.
 *
 * esbuild treats `createRequire` as an opaque call: nothing it loads is ever
 * resolved, so such packages are neither bundled nor collected as externals
 * and are missing from deployed images. The source is parsed with
 * `@babel/parser`, so comments, strings, templates, regex literals and JSX
 * can never confuse the scan; a file that fails to parse is skipped
 * (diagnostics must never fail a build). Binding tracking is name-based,
 * module-level, and per-file: computed specifiers, shadowed names, and a
 * require function imported from another file are not followed.
 */
export function scanSourceForCreateRequire(source: string): CreateRequireSpecifier[] {
  if (!source.includes("createRequire")) {
    return [];
  }

  const ast = parseWithFallbacks(source);

  if (!ast) {
    return [];
  }

  const collected = collectAstFacts(ast);

  const aliases = new Set<string>();
  const namespaces = new Set<string>();

  for (const moduleImport of collected.moduleImports) {
    if (moduleImport.kind === "createRequire") {
      aliases.add(moduleImport.localName);
    } else {
      namespaces.add(moduleImport.localName);
    }
  }

  if (aliases.size === 0 && namespaces.size === 0) {
    return [];
  }

  const isCreateRequireCall = (node: AstNode): boolean => {
    if (node.type !== "CallExpression") {
      return false;
    }

    const callee = node.callee as AstNode;

    if (callee.type === "Identifier") {
      return aliases.has(callee.name as string);
    }

    if (callee.type === "MemberExpression") {
      const object = callee.object as AstNode;
      const property = callee.property as AstNode;

      return (
        object.type === "Identifier" &&
        namespaces.has(object.name as string) &&
        property.type === "Identifier" &&
        property.name === "createRequire"
      );
    }

    return false;
  };

  const requireFnNames = new Set<string>();

  for (const binding of collected.bindings) {
    if (isCreateRequireCall(binding.value)) {
      requireFnNames.add(binding.name);
    }
  }

  const lines = source.split("\n");
  const specifiers: CreateRequireSpecifier[] = [];
  const seenStarts = new Set<number>();

  for (const call of collected.calls) {
    const callee = call.callee;

    const isRequireFnCall =
      (callee.type === "Identifier" && requireFnNames.has(callee.name as string)) ||
      (callee.type === "MemberExpression" &&
        (callee.object as AstNode).type === "Identifier" &&
        requireFnNames.has((callee.object as AstNode).name as string) &&
        (callee.property as AstNode).type === "Identifier" &&
        (callee.property as AstNode).name === "resolve");

    if (!isRequireFnCall && !isCreateRequireCall(callee)) {
      continue;
    }

    if (
      call.specifier === undefined ||
      call.start === undefined ||
      seenStarts.has(call.start) ||
      !isWarnableSpecifier(call.specifier)
    ) {
      continue;
    }

    seenStarts.add(call.start);
    specifiers.push({
      specifier: call.specifier,
      line: call.line,
      column: call.column,
      lineText: lines[call.line - 1] ?? "",
    });
  }

  specifiers.sort((a, b) => a.line - b.line || a.column - b.column);

  return specifiers;
}

type AstNode = {
  type: string;
  start?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
};

const MODULE_BUILTIN_SPECIFIERS = new Set(["module", "node:module"]);
const PARSER_PLUGIN_ATTEMPTS: ParserPlugin[][] = [["typescript", "jsx"], ["typescript"], []];

function parseWithFallbacks(source: string): AstNode | undefined {
  for (const plugins of PARSER_PLUGIN_ATTEMPTS) {
    try {
      return parse(source, {
        sourceType: "unambiguous",
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        plugins,
      }) as unknown as AstNode;
    } catch (error) {
      logger.debug("[createRequire] Parse attempt failed", { plugins, error });
    }
  }

  return undefined;
}

type AstFacts = {
  moduleImports: Array<{ kind: "createRequire" | "namespace"; localName: string }>;
  bindings: Array<{ name: string; value: AstNode }>;
  calls: Array<{
    callee: AstNode;
    specifier: string | undefined;
    start: number | undefined;
    line: number;
    column: number;
  }>;
};

function collectAstFacts(ast: AstNode): AstFacts {
  const facts: AstFacts = {
    moduleImports: [],
    bindings: [],
    calls: [],
  };

  const visit = (node: AstNode) => {
    switch (node.type) {
      case "ImportDeclaration": {
        collectImportDeclaration(node, facts);

        return;
      }
      case "VariableDeclarator": {
        collectVariableDeclarator(node, facts);
        break;
      }
      case "AssignmentExpression": {
        const left = node.left as AstNode;
        const right = node.right as AstNode;

        if (node.operator === "=" && left.type === "Identifier") {
          facts.bindings.push({ name: left.name as string, value: right });
        }

        break;
      }
      case "CallExpression": {
        const args = node.arguments as AstNode[];

        facts.calls.push({
          callee: node.callee as AstNode,
          specifier: stringArgumentValue(args[0]),
          start: node.start ?? undefined,
          line: node.loc?.start.line ?? 1,
          column: node.loc?.start.column ?? 0,
        });

        break;
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isAstNode(item)) {
            visit(item);
          }
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  };

  visit(ast);

  return facts;
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function collectImportDeclaration(node: AstNode, facts: AstFacts) {
  const importSource = node.source as AstNode;

  if (!MODULE_BUILTIN_SPECIFIERS.has(importSource.value as string)) {
    return;
  }

  for (const specifier of node.specifiers as AstNode[]) {
    const localName = (specifier.local as AstNode).name as string;

    if (specifier.type === "ImportSpecifier") {
      const imported = specifier.imported as AstNode;

      if (imported.type === "Identifier" && imported.name === "createRequire") {
        facts.moduleImports.push({ kind: "createRequire", localName });
      }
    } else {
      facts.moduleImports.push({ kind: "namespace", localName });
    }
  }
}

function collectVariableDeclarator(node: AstNode, facts: AstFacts) {
  const id = node.id as AstNode;
  const init = node.init as AstNode | null;

  if (!init) {
    return;
  }

  if (isModuleBuiltinLoad(init)) {
    if (id.type === "Identifier") {
      facts.moduleImports.push({ kind: "namespace", localName: id.name as string });
    } else if (id.type === "ObjectPattern") {
      for (const property of id.properties as AstNode[]) {
        if (property.type !== "ObjectProperty") {
          continue;
        }

        const key = property.key as AstNode;
        const value = property.value as AstNode;

        if (
          key.type === "Identifier" &&
          key.name === "createRequire" &&
          value.type === "Identifier"
        ) {
          facts.moduleImports.push({ kind: "createRequire", localName: value.name as string });
        }
      }
    }

    return;
  }

  if (id.type === "Identifier") {
    facts.bindings.push({ name: id.name as string, value: init });
  }
}

function isModuleBuiltinLoad(node: AstNode): boolean {
  const call = node.type === "AwaitExpression" ? (node.argument as AstNode) : node;

  if (call.type !== "CallExpression") {
    return false;
  }

  const callee = call.callee as AstNode;
  const isLoader =
    (callee.type === "Identifier" && callee.name === "require") || callee.type === "Import";

  if (!isLoader) {
    return false;
  }

  const args = call.arguments as AstNode[];
  const arg = args[0];

  return (
    arg !== undefined &&
    arg.type === "StringLiteral" &&
    MODULE_BUILTIN_SPECIFIERS.has(arg.value as string)
  );
}

function stringArgumentValue(node: AstNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === "StringLiteral") {
    return node.value as string;
  }

  if (node.type === "TemplateLiteral" && (node.expressions as AstNode[]).length === 0) {
    const quasis = node.quasis as AstNode[];
    const value = quasis[0]?.value as { cooked?: string } | undefined;

    return value?.cooked;
  }

  return undefined;
}

function isWarnableSpecifier(specifier: string): boolean {
  if (
    specifier.length === 0 ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:") ||
    specifier.includes("\\") ||
    /^[A-Za-z]:/.test(specifier)
  ) {
    return false;
  }

  return isBareModuleImport(specifier) && !isBuiltinModule(packageNameForImportPath(specifier));
}

const SCANNABLE_FILE_REGEX = /\.(?:m|c)?(?:j|t)sx?$/;
export const NODE_MODULES_SEGMENT_REGEX = /(?:^|[\\/])node_modules[\\/]/;
const FILE_READ_CONCURRENCY = 16;

type CollectorCacheEntry = {
  mtimeMs: number;
  size: number;
  specifiers: CreateRequireSpecifier[];
};

/**
 * Scans the bundle's input files for packages loaded through `createRequire`.
 * Only files outside `node_modules` are scanned: bundled libraries commonly
 * use optional-require patterns that would drown real findings in noise.
 * Each file is scanned independently; results are cached per file by mtime
 * and size so dev rebuilds only re-read changed files.
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
          if (!result.metafile) {
            this._usages = [];

            return;
          }

          try {
            this._usages = await this.collect(result.metafile);
          } catch (error) {
            logger.debug("[createRequire] Scan failed; skipping warnings", { error });
            this._usages = [];
          }
        });
      },
    };

    return this._plugin;
  }

  private async collect(metafile: esbuild.Metafile): Promise<CreateRequireUsage[]> {
    const files: Array<{ inputPath: string; filePath: string }> = [];
    const seenPaths = new Set<string>();

    for (const inputPath of Object.keys(metafile.inputs)) {
      const cleanPath = inputPath.split("?")[0]!;

      if (
        seenPaths.has(cleanPath) ||
        !SCANNABLE_FILE_REGEX.test(cleanPath) ||
        NODE_MODULES_SEGMENT_REGEX.test(cleanPath)
      ) {
        continue;
      }

      seenPaths.add(cleanPath);
      files.push({
        inputPath: cleanPath,
        filePath: isAbsolute(cleanPath) ? cleanPath : resolve(this.workingDir, cleanPath),
      });
    }

    const limit = pLimit(FILE_READ_CONCURRENCY);

    const scanned = await Promise.all(
      files.map((file) =>
        limit(async () => {
          const [statError, stats] = await tryCatch(stat(file.filePath));

          if (statError) {
            logger.debug("[createRequire] Unable to stat bundle input file", {
              filePath: file.filePath,
              error: statError,
            });

            return undefined;
          }

          const cached = this._cache.get(file.filePath);

          if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
            return { inputPath: file.inputPath, specifiers: cached.specifiers };
          }

          const [readError, contents] = await tryCatch(readFile(file.filePath, "utf8"));

          if (readError) {
            logger.debug("[createRequire] Unable to read bundle input file", {
              filePath: file.filePath,
              error: readError,
            });

            return undefined;
          }

          const specifiers = scanSourceForCreateRequire(contents);

          this._cache.set(file.filePath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            specifiers,
          });

          return { inputPath: file.inputPath, specifiers };
        })
      )
    );

    const usages: CreateRequireUsage[] = [];

    for (const entry of scanned) {
      if (!entry) {
        continue;
      }

      for (const found of entry.specifiers) {
        usages.push({
          ...found,
          file: entry.inputPath,
          packageName: packageNameForImportPath(found.specifier),
        });
      }
    }

    return usages;
  }
}

export type ExtensionInstalledPackages = {
  matchers: RegExp[];
  /**
   * True when what extensions install can't be determined in a way that
   * makes false warnings likely: an extension hook threw, or an
   * additionalPackages extension predates the installedPackagesForTarget
   * hook (the exact extension the warning's own fix advice prescribes).
   * Dev-mode warnings stay silent in that case; deploy-mode warnings are
   * unaffected because the manifest externals capture layer dependencies
   * there. Extensions that declare nothing are assumed to install nothing:
   * package-installing extensions are the rare case and declare themselves.
   */
  incomplete: boolean;
};

/**
 * Package-name matchers for everything the configured build extensions
 * declare they install into or externalize for the deployed image. Reads
 * only the user's configured extensions; call it before internal extensions
 * (e.g. the externals collector) are prepended to the build context, and it
 * skips them by name as a second guard. Never throws: diagnostics must not
 * fail a build.
 */
export function extensionInstalledPackageMatchers(
  config: ResolvedConfig
): ExtensionInstalledPackages {
  const matchers: RegExp[] = [];
  let incomplete = false;

  for (const buildExtension of config.build?.extensions ?? []) {
    if (buildExtension.name === "externals") {
      continue;
    }

    try {
      const declaresPackages =
        typeof buildExtension.installedPackagesForTarget === "function" ||
        typeof buildExtension.externalsForTarget === "function";

      if (!declaresPackages) {
        if (buildExtension.name === "additionalPackages") {
          incomplete = true;
        }

        continue;
      }

      const declared = [
        ...(buildExtension.installedPackagesForTarget?.("deploy") ?? []),
        ...(buildExtension.externalsForTarget?.("deploy") ?? []),
      ];

      for (const packageName of declared) {
        matchers.push(makeExternalRegexp(packageName));
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

const INSTALL_COMMAND_REGEX = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b([^&|;]*)/gi;

/**
 * Package names installed by build-layer commands (`RUN npm install pkg`
 * etc.). Such installs never reach the manifest externals, so the packages
 * they name must not warn; commands that install nothing specific (npm ci,
 * bun run) contribute nothing.
 */
export function packagesInstalledByCommands(commands: ReadonlyArray<string>): string[] {
  const names = new Set<string>();

  for (const command of commands) {
    for (const match of command.matchAll(INSTALL_COMMAND_REGEX)) {
      for (const token of match[1]!.trim().split(/\s+/)) {
        if (token.length === 0 || token.startsWith("-")) {
          continue;
        }

        const aliasIndex = token.indexOf("@npm:");

        if (aliasIndex > 0) {
          names.add(token.slice(0, aliasIndex));
          continue;
        }

        if (token.includes(":")) {
          continue;
        }

        const versionAt = token.lastIndexOf("@");
        const name = versionAt > 0 ? token.slice(0, versionAt) : token;

        if (name.length > 0 && !name.startsWith(".") && !name.startsWith("/")) {
          names.add(name);
        }
      }
    }
  }

  return Array.from(names);
}

/**
 * The shared dev/deploy warning pipeline: suppress usages that will be
 * available in the image (manifest externals, extension-declared packages,
 * packages named in build-layer install commands), render the rest. Returns
 * [] instead of throwing on any internal failure, and stays silent for dev
 * when extension-installed packages can't be determined (see
 * ExtensionInstalledPackages.incomplete).
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

    const matchers = [
      ...extensionPackages.matchers,
      ...packagesInstalledByCommands(buildManifest.build?.commands ?? []).map(makeExternalRegexp),
    ];

    const installedPackages = new Set(
      (buildManifest.externals ?? []).map((external) => external.name)
    );

    return unavailableCreateRequireUsages(usages, installedPackages, matchers).map((usage) =>
      createRequireUsageToWarning(usage, target)
    );
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
