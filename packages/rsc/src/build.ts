import { BuildExtension } from "@trigger.dev/core/v3/build";
import { sourceDir } from "./sourceDir.js";

export type RSCExtensionOptions = {
  resolveDir?: string;
  reactDomEnvironment?: "node" | "worker" | "bun";
};

export function rscExtension(options?: RSCExtensionOptions): BuildExtension {
  return {
    name: "rsc",
    onBuildStart(context) {
      context.addLayer({
        id: "rsc",
        conditions: ["react-server"],
      });

      const srcDir = options?.resolveDir ?? sourceDir;

      context.config.build.conditions ??= [];
      context.config.build.conditions.push("react-server");

      context.registerPlugin({
        name: "rsc",
        async setup(build) {
          const { resolvePathSync: esmResolveSync } = await import("mlly");

          build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, (args) => {
            context.logger.debug("Resolving jsx-dev-runtime", { args });

            try {
              const resolvedPath = esmResolveSync(args.path, {
                url: srcDir,
                conditions: ["react-server"],
              });

              context.logger.debug("Resolved jsx-dev-runtime", { resolvedPath });

              return {
                path: resolvedPath,
              };
            } catch (error) {
              context.logger.debug("Failed to resolve jsx-dev-runtime", { error });
            }

            return undefined;
          });

          build.onResolve({ filter: /^react\/jsx-runtime$/ }, (args) => {
            context.logger.debug("Resolving jsx-runtime", { args });

            try {
              const resolvedPath = esmResolveSync(args.path, {
                url: srcDir,
                conditions: ["react-server"],
              });

              context.logger.debug("Resolved jsx-runtime", { resolvedPath });

              return {
                path: resolvedPath,
              };
            } catch (error) {
              context.logger.debug("Failed to resolve jsx-runtime", { error });
            }

            return undefined;
          });

          build.onResolve({ filter: /^(react|react-dom)$/ }, (args) => {
            context.logger.debug("Resolving react", { args });

            try {
              const resolvedPath = esmResolveSync(args.path, {
                url: srcDir,
                conditions: ["react-server"],
              });

              context.logger.debug("Resolved react", { resolvedPath });

              return {
                path: resolvedPath,
              };
            } catch (error) {
              context.logger.debug("Failed to resolve react", { error });
            }

            return undefined;
          });

          build.onResolve({ filter: /^react-dom\/server$/ }, (args) => {
            const condition = options?.reactDomEnvironment ?? "node";

            context.logger.debug("Resolving react-dom/server", { args, condition });

            try {
              const resolvedPath = esmResolveSync(args.path, {
                url: srcDir,
                conditions: [condition],
              });

              context.logger.debug("Resolved react-dom/server", { resolvedPath });

              return {
                path: resolvedPath,
              };
            } catch (error) {
              context.logger.debug("Failed to resolve react-dom/server", { error });
            }

            return undefined;
          });
        },
      });
    },
  };
}
