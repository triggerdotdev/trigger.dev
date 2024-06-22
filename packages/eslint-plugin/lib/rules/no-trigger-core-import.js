/**
 * @fileoverview Prevent importing from `@trigger.dev/core` directly
 */
"use strict";

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const tsconfigPaths = require("tsconfig-paths");

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

const blockedImportSources = ["@trigger.dev/core", "@trigger.dev/core/v3"];
const allowedBarrelFiles = getAllowedBarrelFiles();

function getAllowedBarrelFiles() {
  const packageJsonPath = path.resolve(
    process.cwd().replace("apps/webapp", "").replace("packages/eslint-plugin", ""),
    "packages/core/package.json"
  );

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const exports = packageJson.exports;

  let allowedFiles = [];
  for (let key in exports) {
    if (exports.hasOwnProperty(key)) {
      key = key.replace(/^\.\/?/, "");
      if (key === "package.json") continue;

      allowedFiles.push(["@trigger.dev/core", key].filter(Boolean).join("/"));
    }
  }

  // sort by length so that longest path is first
  allowedFiles.sort((a, b) => b.length - a.length);

  // Filter out the blocked import sources
  return allowedFiles.filter((file) => !blockedImportSources.includes(file));
}

function pathToCorePath(filePath) {
  const baseName = "@trigger.dev/core";
  const relativePath = filePath
    .split("packages/core/src/")[1]
    .replace(/\\/g, "/")
    .replace("/index.ts", "");
  return `${baseName}/${relativePath}`;
}

function resolveSpecifier(importSource, specifier, context) {
  const corePath = resolveModulePath(importSource);
  const coreDir = path.dirname(corePath);

  const resolvedPath = resolveExport(coreDir, specifier);
  if (resolvedPath) {
    for (const allowedBarrelFile of allowedBarrelFiles) {
      if (pathToCorePath(resolvedPath).startsWith(allowedBarrelFile)) {
        return allowedBarrelFile;
      }
    }

    return pathToCorePath(resolvedPath);
  }
  return null;

  function resolveExport(fileOrDir, specifier) {
    const filePath = fs.lstatSync(fileOrDir).isDirectory()
      ? path.join(fileOrDir, "index.ts")
      : fileOrDir;

    if (!fs.existsSync(filePath)) return null;

    const code = fs.readFileSync(filePath, "utf8");
    const ast = parser.parse(code, { sourceType: "module", plugins: ["typescript"] });

    let foundPath = null;

    traverse(ast, {
      ExportNamedDeclaration({ node }) {
        if (node.declaration) {
          if (
            // export const foo = 'bar';
            (node.declaration.type === "VariableDeclaration" &&
              node.declaration.declarations.some((decl) => decl.id.name === specifier)) ||
            // export function foo() {}
            (node.declaration.type === "FunctionDeclaration" &&
              node.declaration.id.name === specifier) ||
            // export class Foo {}
            (node.declaration.type === "ClassDeclaration" &&
              node.declaration.id.name === specifier) ||
            // export type Foo = {};
            (node.declaration.type === "TSTypeAliasDeclaration" &&
              node.declaration.id.name === specifier) ||
            // export interface Foo {}
            (node.declaration.type === "TSInterfaceDeclaration" &&
              node.declaration.id.name === specifier)
          ) {
            foundPath = filePath;
            return;
          }
        } else if (node.specifiers) {
          for (const exportSpecifier of node.specifiers) {
            if (exportSpecifier.exported.name === specifier) {
              const sourcePath = node.source.value;
              const dir = fs.lstatSync(fileOrDir).isDirectory()
                ? fileOrDir
                : path.dirname(fileOrDir);
              const resolvedSourcePath = tryResolveSourcePath(dir, sourcePath);

              if (resolvedSourcePath) {
                const resolvedExport = resolveExport(resolvedSourcePath, specifier);
                if (resolvedExport) {
                  foundPath = resolvedExport;
                  return;
                }
              }
            }
          }
        }
      },
      ExportAllDeclaration({ node }) {
        const sourcePath = node.source.value;
        const dir = fs.lstatSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
        const resolvedSourcePath = tryResolveSourcePath(dir, sourcePath);

        if (resolvedSourcePath) {
          const resolvedExport = resolveExport(resolvedSourcePath, specifier);
          if (resolvedExport) {
            foundPath = resolvedExport;
          }
        }
      },
    });

    return foundPath ? foundPath : null;
  }
}

function tryResolveSourcePath(baseDir, sourcePath) {
  const possibleExtensions = ["", ".ts", ".tsx", ".js", ".jsx"];
  const possibleIndexFiles = ["index.ts", "index.tsx", "index.js", "index.jsx"];

  for (const ext of possibleExtensions) {
    const fullPath = path.resolve(baseDir, `${sourcePath}${ext}`);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  const dirPath = path.resolve(baseDir, sourcePath);
  if (fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory()) {
    for (const indexFile of possibleIndexFiles) {
      const indexPath = path.join(dirPath, indexFile);
      if (fs.existsSync(indexPath)) {
        return indexPath;
      }
    }
  }

  return null;
}

// Configure tsconfig-paths
function resolveModulePath(sourcePath) {
  const cwd = path.resolve(process.cwd());
  const tsconfigPath = path.resolve(cwd, "tsconfig.json");
  const { absoluteBaseUrl, paths } = tsconfigPaths.loadConfig(tsconfigPath);

  if (!absoluteBaseUrl || !paths) {
    throw new Error("Could not load tsconfig paths");
  }

  const matchPath = tsconfigPaths.createMatchPath(absoluteBaseUrl, paths);

  let resolvedPath = matchPath(sourcePath, undefined, undefined, [".ts", ".tsx", ".js", ".jsx"]);

  if (resolvedPath) {
    if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory()) {
      const indexResolvedPath = path.join(resolvedPath, "index.ts");
      if (fs.existsSync(indexResolvedPath)) {
        resolvedPath = indexResolvedPath;
      }
    }

    return path.resolve(resolvedPath);
  }

  return path.resolve(sourcePath);
}

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Prevent importing from `@trigger.dev/core` or `@trigger.dev/core/v3` directly",
      recommended: true,
      url: null,
    },
    fixable: "code",
    schema: [],
    messages: {
      noTriggerCoreImportFixable: "Use specific import from '{{resolvedPath}}'",
      noTriggerCoreImportNeedsExport:
        "Should export from {{resolvedPath}} but not covered by @trigger.dev/core/package.json#exports",
      noTriggerCoreImport:
        "Cannot import from {{importSource}} but no specific import is available",
    },
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const importSource = node.source.value;

        if (blockedImportSources.includes(importSource)) {
          const specifierFixes = node.specifiers
            .map((specifier) => {
              const resolvedPath = resolveSpecifier(importSource, specifier.imported.name, context);
              if (
                resolvedPath &&
                !blockedImportSources.includes(resolvedPath.replace("/index.ts", ""))
              ) {
                return {
                  original: context.getSourceCode().getText(specifier),
                  path: resolvedPath,
                };
              }

              return null;
            })
            .filter(Boolean);

          if (specifierFixes.length > 0) {
            const fixes = specifierFixes
              .map((fix) => {
                return `import { ${fix.original.replace("type ", "")} } from '${fix.path}';`;
              })
              .join("\n");

            if (specifierFixes.every((fix) => allowedBarrelFiles.includes(fix.path))) {
              context.report({
                node,
                messageId: "noTriggerCoreImportFixable",
                data: {
                  importSource,
                  name: node.specifiers.map((spec) => spec.local.name).join(", "),
                  resolvedPath: Array.from(new Set(specifierFixes.map((fix) => fix.path))).join(
                    ", "
                  ),
                },
                fix(fixer) {
                  return fixer.replaceText(node, fixes);
                },
              });
            } else {
              context.report({
                node,
                messageId: "noTriggerCoreImportNeedsExport",
                data: {
                  importSource,
                  name: node.specifiers.map((spec) => spec.local.name).join(", "),
                  resolvedPath: Array.from(
                    new Set(
                      specifierFixes
                        .filter((fix) => !allowedBarrelFiles.includes(fix.path))
                        .map((fix) => fix.path)
                    )
                  ).join(", "),
                },
              });
            }
          } else {
            context.report({
              node,
              messageId: "noTriggerCoreImport",
              data: {
                importSource,
              },
            });
          }
        }
      },
    };
  },
};
