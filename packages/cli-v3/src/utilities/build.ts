import type * as esbuild from "esbuild";
import type { Plugin } from "esbuild";
import { readFileSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import tsConfigPaths from "tsconfig-paths";
import { logger } from "./logger";

export function workerSetupImportConfigPlugin(configPath?: string): Plugin {
  return {
    name: "trigger-worker-setup",
    setup(build) {
      if (!configPath) {
        return;
      }

      build.onLoad({ filter: /worker-setup\.js$/ }, async (args) => {
        let workerSetupContents = readFileSync(args.path, "utf-8");

        workerSetupContents = workerSetupContents.replace(
          "__SETUP_IMPORTED_PROJECT_CONFIG__",
          `import * as setupImportedConfigExports from "${configPath}"; const setupImportedConfig = setupImportedConfigExports.config;`
        );

        logger.debug("Loading worker setup", {
          args,
          workerSetupContents,
          configPath,
        });

        return {
          contents: workerSetupContents,
          loader: "js",
        };
      });
    },
  };
}

export function bundleDependenciesPlugin(
  buildIdentifier: string,
  dependenciesToBundle?: Array<string | RegExp>,
  tsconfigPath?: string
): Plugin {
  const matchPath = tsconfigPath ? createMatchPath(tsconfigPath) : undefined;

  function resolvePath(id: string) {
    if (!matchPath) {
      return id;
    }
    return matchPath(id, undefined, undefined, [".ts", ".tsx", ".js", ".jsx"]) || id;
  }

  return {
    name: "trigger-bundle-dependencies",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const resolvedPath = resolvePath(args.path);

        if (!isBareModuleId(resolvedPath)) {
          return undefined; // let esbuild handle it
        }

        // Skip assets that are treated as files (.css, .svg, .png, etc.).
        // Otherwise, esbuild would emit code that would attempt to require()
        // or import these files --- which aren't JavaScript!
        let loader;
        try {
          loader = getLoaderForFile(args.path);
        } catch (e) {
          if (!(e instanceof Error && e.message.startsWith("Cannot get loader for file"))) {
            throw e;
          }
        }
        if (loader === "file") {
          return undefined;
        }

        for (let pattern of dependenciesToBundle ?? []) {
          if (typeof pattern === "string" ? args.path === pattern : pattern.test(args.path)) {
            return undefined; // let esbuild bundle it
          }
        }

        logger.ignore(`[${buildIdentifier}] Externalizing ${args.path}`, {
          ...args,
        });

        // Everything else should be external
        return {
          path: args.path,
          external: true,
        };
      });
    },
  };
}

function isBareModuleId(id: string): boolean {
  return !id.startsWith("node:") && !id.startsWith(".") && !isAbsolute(id);
}

export function createMatchPath(tsconfigPath: string | undefined) {
  // There is no tsconfig to match paths against.
  if (!tsconfigPath) {
    return undefined;
  }

  // When passing a absolute path, loadConfig assumes that the path contains
  // a tsconfig file.
  // Ref.: https://github.com/dividab/tsconfig-paths/blob/v4.0.0/src/__tests__/config-loader.test.ts#L74
  let configLoaderResult = tsConfigPaths.loadConfig(tsconfigPath);

  if (configLoaderResult.resultType === "failed") {
    if (configLoaderResult.message === "Missing baseUrl in compilerOptions") {
      throw new Error(
        `🚨 Oops! No baseUrl found, please set compilerOptions.baseUrl in your tsconfig or jsconfig`
      );
    }
    return undefined;
  }

  return tsConfigPaths.createMatchPath(
    configLoaderResult.absoluteBaseUrl,
    configLoaderResult.paths,
    configLoaderResult.mainFields,
    configLoaderResult.addMatchAll
  );
}

const loaders: { [ext: string]: esbuild.Loader } = {
  ".aac": "file",
  ".avif": "file",
  ".css": "file",
  ".csv": "file",
  ".eot": "file",
  ".fbx": "file",
  ".flac": "file",
  ".gif": "file",
  ".glb": "file",
  ".gltf": "file",
  ".gql": "text",
  ".graphql": "text",
  ".hdr": "file",
  ".ico": "file",
  ".jpeg": "file",
  ".jpg": "file",
  ".js": "jsx",
  ".jsx": "jsx",
  ".json": "json",
  // We preprocess md and mdx files using @mdx-js/mdx and send through
  // the JSX for esbuild to handle
  ".md": "jsx",
  ".mdx": "jsx",
  ".mov": "file",
  ".mp3": "file",
  ".mp4": "file",
  ".node": "copy",
  ".ogg": "file",
  ".otf": "file",
  ".png": "file",
  ".psd": "file",
  ".sql": "text",
  ".svg": "file",
  ".ts": "ts",
  ".tsx": "tsx",
  ".ttf": "file",
  ".wasm": "file",
  ".wav": "file",
  ".webm": "file",
  ".webmanifest": "file",
  ".webp": "file",
  ".woff": "file",
  ".woff2": "file",
  ".zip": "file",
};

export function getLoaderForFile(file: string): esbuild.Loader {
  const ext = extname(file);
  const loader = loaders[ext];

  if (loader) return loader;

  throw new Error(`Cannot get loader for file ${file}`);
}
