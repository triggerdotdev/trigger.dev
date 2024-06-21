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
const allowedBarrelFiles = ["@trigger.dev/core/schemas", "@trigger.dev/core/v3/schemas"];

function resolveSpecifier(importSource, specifier, context) {
  const corePath = resolveModulePath(importSource);
  const coreDir = path.dirname(corePath);

  const resolvedPath = resolveExport(coreDir, specifier);
  if (resolvedPath) {
    const baseName = "@trigger.dev/core";
    const relativePath = resolvedPath.split("packages/core/src/")[1].replace(/\\/g, "/");
    const finalPath = `${baseName}/${relativePath}`;

    // Check if the resolved path should map to an allowed barrel file
    for (const barrelFile of allowedBarrelFiles) {
      if (finalPath.startsWith(barrelFile)) {
        return barrelFile;
      }
    }

    return removeExtensionAndIndex(finalPath);
  }
  return null;
}

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
          node.declaration.type === "VariableDeclaration" &&
          node.declaration.declarations.some((decl) => decl.id.name === specifier)
        ) {
          foundPath = filePath;
          return;
        }

        if (
          node.declaration.type === "FunctionDeclaration" &&
          node.declaration.id.name === specifier
        ) {
          foundPath = filePath;
          return;
        }

        if (
          node.declaration.type === "ClassDeclaration" &&
          node.declaration.id.name === specifier
        ) {
          foundPath = filePath;
          return;
        }
      } else if (node.specifiers) {
        for (const exportSpecifier of node.specifiers) {
          if (exportSpecifier.exported.name === specifier) {
            const sourcePath = node.source.value;
            const dir = fs.lstatSync(fileOrDir).isDirectory() ? fileOrDir : path.dirname(fileOrDir);
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

function removeExtensionAndIndex(filePath) {
  return filePath
    .replace(/\/index(\.ts|\.tsx|\.js|\.jsx)$/, "")
    .replace(/(\.ts|\.tsx|\.js|\.jsx)$/, "");
}

// Configure tsconfig-paths
function resolveModulePath(sourcePath) {
  const cwd = path.resolve(process.cwd());
  const tsconfigPath = path.resolve(cwd, "tsconfig.json");
  const tsconfig = require(tsconfigPath);
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
      noTriggerCoreImport: "{{name}} should be imported from '{{resolvedPath}}'",
    },
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const importSource = node.source.value;

        if (blockedImportSources.includes(importSource)) {
          const specifierFixes = node.specifiers
            .map((specifier) => {
              const resolvedPath = resolveSpecifier(importSource, specifier.local.name, context);
              if (resolvedPath) {
                return {
                  name: specifier.local.name,
                  path: resolvedPath,
                };
              }
              return null;
            })
            .filter(Boolean);

          if (specifierFixes.length > 0) {
            const fixes = specifierFixes
              .map((fix) => {
                return `import { ${fix.name} } from '${fix.path}';`;
              })
              .join("\n");

            context.report({
              node,
              messageId: "noTriggerCoreImport",
              data: {
                name: node.specifiers.map((spec) => spec.local.name).join(", "),
                resolvedPath: fixes,
              },
              fix(fixer) {
                return fixer.replaceText(node, fixes);
              },
            });
          }
        }
      },
    };
  },
};
