import { BuildTarget } from "@trigger.dev/core/v3";
import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import { dirname, resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readPackageJSON } from "pkg-types";

export type SecureExecOptions = {
  /**
   * Packages available inside the sandbox at runtime.
   *
   * These are `require()`'d inside the V8 isolate at runtime — the bundler
   * never sees them statically. They are marked external and installed as
   * deploy dependencies.
   *
   * @example
   * ```ts
   * secureExec({ packages: ["jszip", "lodash"] })
   * ```
   */
  packages?: string[];
};

/**
 * Build extension for [secure-exec](https://secureexec.dev) — run untrusted
 * JavaScript/TypeScript in V8 isolates with configurable permissions.
 *
 * Handles the esbuild workarounds needed for secure-exec's runtime
 * `require.resolve` calls, native binaries, and module-scope resolution.
 *
 * @example
 * ```ts
 * import { secureExec } from "@trigger.dev/build/extensions/secureExec";
 *
 * export default defineConfig({
 *   build: {
 *     extensions: [secureExec()],
 *   },
 * });
 * ```
 */
export function secureExec(options?: SecureExecOptions): BuildExtension {
  return new SecureExecExtension(options ?? {});
}

class SecureExecExtension implements BuildExtension {
  public readonly name = "SecureExecExtension";

  private userPackages: string[];

  constructor(options: SecureExecOptions) {
    this.userPackages = options.packages ?? [];
  }

  externalsForTarget(_target: BuildTarget) {
    return [
      // esbuild must not be bundled — it locates its native binary via a
      // relative path from its JS API entry point. secure-exec uses esbuild
      // at runtime to bundle polyfills for sandbox code.
      "esbuild",
      // User-specified packages are require()'d inside the V8 sandbox at
      // runtime — the bundler never sees them statically.
      ...this.userPackages,
    ];
  }

  onBuildStart(context: BuildContext) {
    context.logger.debug(`Adding ${this.name} esbuild plugins`);

    // Plugin 1: Replace node-stdlib-browser with pre-resolved paths.
    //
    // Trigger's ESM shim anchors require.resolve() to the chunk path, so
    // node-stdlib-browser's runtime require.resolve("./mock/empty.js") breaks.
    // Fix: load the real node-stdlib-browser at build time (where require.resolve
    // works), capture the resolved path map, and inline it as a static export.
    const workingDir = context.workingDir;
    context.registerPlugin({
      name: "secure-exec-stdlib-resolver",
      setup(build) {
        build.onResolve({ filter: /^node-stdlib-browser$/ }, () => ({
          path: "node-stdlib-browser",
          namespace: "secure-exec-nsb-resolved",
        }));
        build.onLoad({ filter: /.*/, namespace: "secure-exec-nsb-resolved" }, () => {
          const buildRequire = createRequire(join(workingDir, "package.json"));
          const resolved = buildRequire("node-stdlib-browser");
          return {
            contents: `export default ${JSON.stringify(resolved)};`,
            loader: "js",
          };
        });
      },
    });

    // Plugin 2: Inline bridge.js at build time.
    //
    // bridge-loader.js in @secure-exec/node(js) uses __dirname and
    // require.resolve("@secure-exec/core") at module scope to locate
    // dist/bridge.js on disk. This fails in Trigger's bundled output.
    // Fix: read bridge.js content at build time and inline it as a
    // string literal so no runtime filesystem resolution is needed.
    //
    context.registerPlugin({
      name: "secure-exec-bridge-inline",
      setup(build) {
        build.onLoad(
          { filter: /[\\/]@secure-exec[\\/]node[\\/]dist[\\/]bridge-loader\.js$/ },
          (args) => {
            try {
              const buildRequire = createRequire(args.path);
              const coreEntry = buildRequire.resolve("@secure-exec/core");
              const coreRoot = resolve(dirname(coreEntry), "..");
              const bridgeCode = readFileSync(join(coreRoot, "dist", "bridge.js"), "utf8");

              return {
                contents: [
                  `import { getIsolateRuntimeSource } from "@secure-exec/core";`,
                  `const bridgeCodeCache = ${JSON.stringify(bridgeCode)};`,
                  `export function getRawBridgeCode() { return bridgeCodeCache; }`,
                  `export function getBridgeAttachCode() { return getIsolateRuntimeSource("bridgeAttach"); }`,
                ].join("\n"),
                loader: "js",
              };
            } catch {
              // If we can't inline the bridge, let the normal loader handle it.
              return undefined;
            }
          }
        );
      },
    });
  }

  async onBuildComplete(context: BuildContext, _manifest: BuildManifest) {
    if (context.target === "dev") {
      return;
    }

    context.logger.debug(`Adding ${this.name} deploy dependencies`);

    const dependencies: Record<string, string> = {};

    // Resolve versions for user-specified sandbox packages
    for (const pkg of this.userPackages) {
      try {
        const modulePath = await context.resolvePath(pkg);
        if (!modulePath) {
          dependencies[pkg] = "latest";
          continue;
        }

        const packageJSON = await readPackageJSON(dirname(modulePath));
        dependencies[pkg] = packageJSON.version ?? "latest";
      } catch {
        context.logger.warn(
          `Could not resolve version for sandbox package ${pkg}, defaulting to latest`
        );
        dependencies[pkg] = "latest";
      }
    }

    context.addLayer({
      id: "secureExec",
      dependencies,
      image: {
        // isolated-vm requires native compilation tools
        pkgs: ["python3", "make", "g++"],
      },
    });
  }
}
