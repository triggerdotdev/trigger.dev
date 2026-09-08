import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("schema composition compatibility", () => {
  it.each([
    { name: "zod", v3: require.resolve("zod/v3"), v4: require.resolve("zod/v4") },
    {
      name: "zod-v3-floor",
      v3: require.resolve("zod-v3-floor/v3"),
      v4: require.resolve("zod-v3-floor/v4"),
    },
  ])("parses composed schemas with $name and a Zod 3 root", async ({ v3, v4 }) => {
    const result = await build({
      stdin: {
        contents: `
          import { ScheduleMetadata, WebhookMetadata } from "./src/v3/schemas/schemas.ts";
          import { WebhookResource } from "./src/v3/schemas/resources.ts";
          import { FetchRetryHeadersStrategy } from "./src/v3/schemas/fetch.ts";

          const verifierArtifact = {
            kind: "preset",
            preset: "stripe",
            config: { scheme: "shared-secret", placement: "header" },
          };
          const routingTarget = { type: "task", taskId: "my-task" };

          export const parsed = {
            retry: FetchRetryHeadersStrategy.parse({
              strategy: "headers",
              limitHeader: "x-limit",
              remainingHeader: "x-remaining",
              resetHeader: "x-reset",
            }),
            schedule: ScheduleMetadata.parse({
              cron: "0 0 * * *",
              timezone: "UTC",
              window: "10%",
            }),
            metadata: WebhookMetadata.parse({
              id: "my-webhook",
              source: "stripe",
              verifierArtifact,
              routingTarget,
            }),
            resource: WebhookResource.parse({
              id: "my-webhook",
              filePath: "src/trigger.ts",
              source: "stripe",
              verifierArtifact,
              routingTarget,
            }),
          };
        `,
        loader: "ts",
        resolveDir: packageRoot,
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      plugins: [
        {
          name: "resolve-root-zod-to-v3",
          setup(build) {
            build.onResolve({ filter: /^zod$/ }, () => ({
              path: v3,
            }));
            build.onResolve({ filter: /^zod\/v4$/ }, () => ({
              path: v4,
            }));
          },
        },
      ],
    });

    const bundledModule = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
    );

    expect(bundledModule.parsed).toMatchObject({
      retry: { resetFormat: "unix_timestamp" },
      schedule: { window: "10%" },
      metadata: { id: "my-webhook" },
      resource: { id: "my-webhook" },
    });
  });
});
